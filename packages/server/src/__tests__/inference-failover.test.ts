// Incident 18-10 ~14:00Z: Ollama Cloud's weekly usage limit answered every call with an HTTP error. OLLAMA_AUTO_FAILOVER
// detects it and fails opencode leases over to claude; PANEL_FALLBACK_RUNTIME answers panel seats on the subscription;
// INFERENCE_BUDGET_THROTTLE pauses low-value Ollama consumers before the weekly budget runs out. All default off (throttle: shadow).
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { generateText, resetLlmBreaker } from '../services/llm-fallback';
import { setLlmLedger, recordModelCall } from '../services/model-selector';
import { applyOutageFallback } from '../services/ollama-outage-fallback';
import { autoFailoverMode, noteOllamaOutput, ollamaLimitClass, ollamaLimited, probeModel, probeOllama, readOllamaLimit } from '../services/inference-failover';
import { budgetEvidence, budgetPause, ollamaUsage7d, resetBudgetCache, throttleMode } from '../services/inference-budget';
import { detectStallsWithHealth } from '../services/stall-watch';
import { SpecialistPanelService } from '../services/specialist-panel-service';
import { callClaudePanel, panelClaudeArgs, SelfImprovementAgentReviewService, type SpawnFn } from '../services/self-improvement-agent-review-service';
import { PanelCalibrationService } from '../services/panel-calibration-service';
import { specialistAccuracy } from '../services/panel-calibration-shadow';
import { buildEvolutionEvidence } from '../services/evolution-evidence';
import { dreamOnce } from '../services/dream-evolution';
import { AUTH_MISSING } from '../services/subscription-gym';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
/** Ollama Cloud's answer on 18-10 (HTTP 429 assumed; the body is what the detector reads). */
const LIMIT_BODY = fixture('ollama-cloud-weekly-limit.json');
const claudeHelp = fixture('claude-2.1.282-help.txt');

const dbs: Database.Database[] = [];
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); setLlmLedger(null); resetLlmBreaker(); resetBudgetCache();
  for (const d of dbs.splice(0)) d.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});
function freshDb() {
  const db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); dbs.push(db);
  return db;
}
const limitFetch = () => vi.fn(async () => new Response(LIMIT_BODY, { status: 429, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
const ollama = [{ id: 'ollama:https://ollama.com', kind: 'ollama' as const, baseUrl: 'https://ollama.com' }];
const audits = (db: Database.Database) => db.prepare("SELECT action FROM audit_events WHERE resource_type = 'inference_provider' ORDER BY rowid").all().map((r) => (r as { action: string }).action);

describe('Ollama usage-limit shape', () => {
  it('the 18-10 body, session limits and the error marker match; ordinary errors do not', () => {
    expect(ollamaLimitClass(LIMIT_BODY)).toBe('weekly');
    expect(ollamaLimitClass('Error: you have reached your session usage limit, please wait')).toBe('session');
    expect(ollamaLimitClass('AI_APICallError: you (x) have reached your usage limit')).toBe('usage');
    expect(ollamaLimitClass('Ollama request failed: 429 [ollama_usage_limit:weekly] (fallbacks also failed: x)')).toBe('weekly');
    for (const t of ['Ollama request failed: 500', 'fetch failed', 'model "x" not found', '', null]) expect(ollamaLimitClass(t)).toBeNull();
  });
});

describe('OLLAMA_AUTO_FAILOVER', () => {
  it('off (default): the error text is unchanged, the body is not read, nothing is recorded', async () => {
    const db = freshDb(); setLlmLedger(db);
    expect(autoFailoverMode({})).toBe('off');
    await expect(generateText({ prompt: 'x', model: 'm', timeoutMs: 1000 }, { endpoints: ollama, fetchFn: limitFetch() })).rejects.toThrow(/^Ollama request failed: 429$/);
    expect(noteOllamaOutput(db, LIMIT_BODY, 'test', {})).toBe('weekly'); // classified, never recorded
    expect(readOllamaLimit(db)).toBeNull();
    expect(audits(db)).toEqual([]);
  });

  it('on: the limit answer is marked, persisted (survives a restart), audited once, with a 7-d token calibration judgment', async () => {
    vi.stubEnv('OLLAMA_AUTO_FAILOVER', 'on');
    const db = freshDb(); setLlmLedger(db);
    recordModelCall(db, { consumer: 'fallback', model: 'glm-5.3:cloud', provider: 'ollama:https://ollama.com', ok: true, latencyMs: 1, outChars: 1, shadow: 0, agree: null, tokensIn: 300, tokensOut: 45 });
    await expect(generateText({ prompt: 'x', model: 'm', timeoutMs: 1000, purpose: 'panel_review:review' }, { endpoints: ollama, fetchFn: limitFetch() }))
      .rejects.toThrow('Ollama request failed: 429 [ollama_usage_limit:weekly]');
    const s = readOllamaLimit(db);
    expect(s).toMatchObject({ state: 'ollama_limited', error_class: 'weekly', source: 'llm:panel_review:review' });
    expect(typeof s?.detected_at).toBe('string');
    await expect(generateText({ prompt: 'x', model: 'm', timeoutMs: 1000 }, { endpoints: ollama, fetchFn: limitFetch() })).rejects.toThrow();
    expect(readOllamaLimit(db)?.detected_at).toBe(s?.detected_at); // the first detection stays
    expect(audits(db)).toEqual(['inference_ollama_limited']);
    const j = db.prepare("SELECT decision, answers_json FROM judgments WHERE judgment = 'ollama_limit_calibration'").all() as Array<{ decision: string; answers_json: string }>;
    expect(j).toHaveLength(1);
    expect(JSON.parse(j[0].answers_json)).toMatchObject({ total_tokens: 345, error_class: 'weekly' });
    // a restart: a new reader on the same DB still sees it
    expect(ollamaLimited(db)).toBe(true);
  });

  it('on + limited: an opencode lease fails over to claude (trigger auto); the manual flag still wins; off ignores the stored state', () => {
    const db = freshDb();
    noteOllamaOutput(db, LIMIT_BODY, 'test', { OLLAMA_AUTO_FAILOVER: 'on' });
    db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, repository_path) VALUES ('r', 'test-gap', 'closed', 'running', '/x')").run();
    const lease = (id: string) => {
      db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES (?, 'r', 'maker', 'opencode', 'prepared', '{}')").run(id);
      return { id, role: 'maker', runtime: 'opencode', metadata: { model: 'ollama/glm-5.3:cloud' } as Record<string, unknown> };
    };
    const run = { id: 'r', loop_name: 'test-gap' };
    expect(applyOutageFallback(db, run, lease('off'), 'opencode', {})).toBe('opencode');
    const auto = lease('auto');
    expect(applyOutageFallback(db, run, auto, 'opencode', { OLLAMA_AUTO_FAILOVER: 'on' })).toBe('claude');
    expect(auto.metadata.runtime_fallback).toMatchObject({ from: 'opencode', to: 'claude', reason: 'ollama_outage', trigger: 'auto', from_model: 'ollama/glm-5.3:cloud' });
    const manual = lease('manual');
    applyOutageFallback(db, run, manual, 'opencode', { OLLAMA_AUTO_FAILOVER: 'on', OLLAMA_OUTAGE_FALLBACK_RUNTIME: 'claude' });
    expect((manual.metadata.runtime_fallback as Record<string, unknown>).trigger).toBeUndefined();
  });

  it('stall-watch detector inference_limited: not_applicable off, a stall while limited', () => {
    const db = freshDb();
    expect(detectStallsWithHealth(db, Date.now(), {}).detectors.find((d) => d.name === 'inference_limited')?.status).toBe('not_applicable');
    const on = { OLLAMA_AUTO_FAILOVER: 'on' };
    expect(detectStallsWithHealth(db, Date.now(), on).stalls.some((s) => s.subsystem === 'inference_limited')).toBe(false);
    noteOllamaOutput(db, LIMIT_BODY, 'opencode:maker', on);
    const stall = detectStallsWithHealth(db, Date.now(), on).stalls.find((s) => s.subsystem === 'inference_limited');
    expect(stall?.detail).toContain('weekly usage limit');
    expect(stall?.since).toBe(readOllamaLimit(db)?.detected_at);
  });

  it('probe: skipped when not limited; failure keeps the state; success clears it with a recovery event', async () => {
    const db = freshDb(); const on = { OLLAMA_AUTO_FAILOVER: 'on' };
    expect(probeModel({})).toBe('glm-5.3-flash:cloud');
    expect(probeModel({ MODEL_COST_WEIGHTS: 'a=3,b:cloud=1' })).toBe('b:cloud');
    const call = vi.fn(async () => 'ok');
    expect(await probeOllama(db, call, on)).toBe('skipped');
    expect(call).not.toHaveBeenCalled();
    noteOllamaOutput(db, LIMIT_BODY, 'test', on);
    expect(await probeOllama(db, async () => { throw new Error('Ollama request failed: 429 [ollama_usage_limit:weekly]'); }, on)).toBe('still_limited');
    expect(readOllamaLimit(db)?.last_probe_result).toContain('429');
    expect(await probeOllama(db, call, on)).toBe('cleared');
    expect(call).toHaveBeenCalledWith('glm-5.3-flash:cloud');
    expect(readOllamaLimit(db)).toBeNull();
    expect(audits(db)).toEqual(['inference_ollama_limited', 'inference_ollama_recovered']);
  });

  it('an opencode maker whose stderr carries the limit records the state (on), and nothing off', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-failover-')); roots.push(root);
    vi.stubEnv('LOOP_WORKTREE_ROOT', path.join(root, 'worktrees'));
    const repo = path.join(root, 'repo'); fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' }); execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-m', 'f'], { cwd: repo, stdio: 'ignore' });
    const run = async (env: Record<string, string>) => {
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      const db = freshDb();
      const loops = new LoopService(db, path.join(root, `evidence-${dbs.length}`));
      db.prepare(`INSERT INTO loop_runs (id,loop_name,mode,status,repository_path,findings_json,metadata) VALUES ('run-1','test-gap','closed','running',?,?,?)`).run(
        repo, JSON.stringify([{ id: 'finding', type: 'todo_marker', severity: 'low', file: 'README.md', message: 'm', evidence: 'x', suggested_fix: 'y' }]), JSON.stringify({ risk_class: 'low' }));
      const assignment = path.join(root, 'assignment.md'); fs.writeFileSync(assignment, 'Fixture assignment');
      loops.insertWorkerLease({ id: 'maker', loopRunId: 'run-1', role: 'maker', runtime: 'opencode', findingId: 'finding', worktreePath: repo, branchName: null,
        now: new Date().toISOString(), metadata: { assignment_file: assignment } });
      vi.spyOn(loops, 'getRuntimeContract').mockReturnValue({ available: true, status: 'ok' } as ReturnType<LoopService['getRuntimeContract']>);
      (loops.workerExecutor as unknown as { executionEngine: unknown }).executionEngine = { executeTask: vi.fn(async () => ({ status: 'running',
        completion: Promise.resolve({ status: 'failed', message: 'x', stdout: '', stderr: `AI_APICallError: ${LIMIT_BODY}`, exitCode: 1 }) })) };
      await loops.executeMaker('run-1', { lease_id: 'maker' }).catch(() => undefined);
      return readOllamaLimit(db);
    };
    expect(await run({})).toBeNull();
    expect(await run({ OLLAMA_AUTO_FAILOVER: 'on' })).toMatchObject({ error_class: 'weekly', source: 'opencode:maker' });
  });
});

describe('PANEL_FALLBACK_RUNTIME', () => {
  const VALID = JSON.stringify({ stance: 'support', confidence: 0.8, findings: ['bounded change'], evidence_refs: ['context:rationale'] });
  function setup() {
    const db = freshDb(); db.pragma('foreign_keys = ON');
    const panels = new SpecialistPanelService(db);
    const panel = panels.createPanel({ topic: 'T', question: 'Q?', risk_class: 'low', specialist_ids: ['systems_architect', 'security_reviewer'],
      metadata: { self_improvement_id: 'si' }, context: { description: 'd', rationale: 'r' } });
    return { db, panel };
  }
  const limitCall = vi.fn(async () => { throw new Error('Ollama request failed: 429 [ollama_usage_limit:weekly]'); });

  it('off: a limit failure stays a failed seat attempt, the fallback is never called', async () => {
    const { db, panel } = setup(); vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fallback = vi.fn(async () => VALID);
    const updated = await new SelfImprovementAgentReviewService(db, limitCall, { callFallback: fallback }).reviewMissingSpecialists(panel.id, 'run-1');
    expect(fallback).not.toHaveBeenCalled();
    expect(updated.reviews ?? []).toHaveLength(0);
  });

  it('claude: a seat whose Ollama call hits the limit is answered on claude — provenance claude:<model>, marker, ledger purpose fallback', async () => {
    vi.stubEnv('PANEL_FALLBACK_RUNTIME', 'claude');
    const { db, panel } = setup();
    const fallback = vi.fn(async (_p: string, _m?: string, usage?: (u: { tokensIn: number | null; tokensOut: number | null; provider: string; model: string }) => void) => {
      usage?.({ tokensIn: 10, tokensOut: 5, provider: 'subscription-cli:claude', model: 'claude:haiku' }); return VALID;
    });
    const updated = await new SelfImprovementAgentReviewService(db, limitCall, { callFallback: fallback }).reviewMissingSpecialists(panel.id, 'run-1');
    expect(fallback.mock.calls.map((c) => c[1])).toEqual(['claude:haiku', 'claude:haiku']);
    expect(updated.reviews).toHaveLength(2);
    expect(db.prepare("SELECT model, reviewer_actor FROM specialist_reviews WHERE specialist_id = 'systems_architect'").get())
      .toEqual({ model: 'claude:haiku', reviewer_actor: 'agent:systems_architect:run-1:panel_fallback' });
    expect(db.prepare("SELECT DISTINCT model, purpose, provider, cost_basis, tokens_in FROM llm_model_calls WHERE consumer = 'panel_review'").all())
      .toEqual([{ model: 'claude:haiku', purpose: 'panel_review:fallback', provider: 'subscription-cli:claude', cost_basis: 'flat_subscription', tokens_in: 10 }]);
  });

  it('claude + Ollama limited: Ollama is not called at all; an invalid fallback answer is quarantined (same B32 path)', async () => {
    vi.stubEnv('PANEL_FALLBACK_RUNTIME', 'claude'); vi.stubEnv('PANEL_FALLBACK_MODEL', 'sonnet'); vi.stubEnv('OLLAMA_AUTO_FAILOVER', 'on');
    const { db, panel } = setup(); vi.spyOn(console, 'warn').mockImplementation(() => {});
    noteOllamaOutput(db, LIMIT_BODY, 'test');
    const primary = vi.fn(async () => VALID);
    await new SelfImprovementAgentReviewService(db, primary, { callFallback: async () => '{"stance":"maybe"}' }).reviewMissingSpecialists(panel.id, 'run-1');
    expect(primary).not.toHaveBeenCalled();
    expect(db.prepare('SELECT model FROM specialist_review_quarantine').all()).toEqual([{ model: 'claude:sonnet' }, { model: 'claude:sonnet' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM specialist_reviews').get()).toEqual({ n: 0 });
  });

  it('a fallback without the OAuth token leaves the seat waiting (no attempt spent)', async () => {
    vi.stubEnv('PANEL_FALLBACK_RUNTIME', 'claude'); vi.stubEnv('OLLAMA_OUTAGE_FALLBACK_RUNTIME', 'claude');
    const { db, panel } = setup(); vi.spyOn(console, 'warn').mockImplementation(() => {});
    const svc = new SelfImprovementAgentReviewService(db, limitCall, { callFallback: async () => { throw new Error(`panel_fallback: ${AUTH_MISSING}`); } });
    for (let i = 0; i < 4; i++) await svc.reviewMissingSpecialists(panel.id, `run-${i}`);
    expect(db.prepare('SELECT error FROM specialist_review_quarantine').all()).toEqual([]);
  });

  it('CLI: print + JSON, plan mode, no tools — every flag exists in the pinned 2.1.282 help; never acceptEdits or a bypass', () => {
    const args = panelClaudeArgs('haiku');
    expect(args.slice(0, 3)).toEqual(['-p', '--output-format', 'json']);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    for (const flag of args.filter((a) => a.startsWith('--'))) expect(claudeHelp, flag).toContain(flag);
    expect(claudeHelp).toMatch(/"dontAsk", "plan"\)/);
    expect(args.join(' ')).not.toMatch(/acceptEdits|bypassPermissions|dangerously/);
  });

  it('CLI call: keys stripped, OAuth token injected, prompt on stdin, result parsed; no token → refused before spawn', async () => {
    const seen: { args?: string[]; env?: NodeJS.ProcessEnv; stdin?: string } = {};
    const spawnFn = vi.fn((_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
        stdin: { end: (s: string) => { seen.stdin = s; setImmediate(() => { child.stdout.emit('data', JSON.stringify({ type: 'result', is_error: false, result: VALID, usage: { input_tokens: 12, output_tokens: 7 } })); child.emit('close', 0); }); } } });
      seen.args = args; seen.env = opts.env;
      return child;
    }) as unknown as SpawnFn;
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test', ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk', ANTHROPIC_BASE_URL: 'http://proxy', PATH: '/bin' };
    const usage = vi.fn();
    expect(await callClaudePanel('the prompt', 'claude:haiku', usage, { spawnFn, env })).toBe(VALID);
    expect(seen.args?.[seen.args.indexOf('--model') + 1]).toBe('haiku');
    expect(seen.stdin).toBe('the prompt');
    expect(seen.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test', PATH: '/bin' });
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_BASE_URL']) expect(seen.env?.[k], k).toBeUndefined();
    expect(usage).toHaveBeenCalledWith({ tokensIn: 12, tokensOut: 7, provider: 'subscription-cli:claude', model: 'claude:haiku' });
    const never = vi.fn() as unknown as SpawnFn;
    await expect(callClaudePanel('p', 'claude:haiku', undefined, { spawnFn: never, env: {} })).rejects.toThrow(AUTH_MISSING);
    expect(never).not.toHaveBeenCalled();
  });

  it('panel calibration (Brier and the weighted shadow) leaves fallback reviews out', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, panel_id, created_at, updated_at)
      VALUES ('p', 'feature', 't', 'd', 'r', 'gap_analysis', 'verified', 0.5, 'pan', datetime('now'), datetime('now'))`).run();
    const review = (id: string, specialist: string, model: string | null) => db.prepare(`INSERT INTO specialist_reviews (id, panel_id, specialist_id, specialist_title, stance, confidence, findings_json, recommendations_json, evidence_refs_json, status, model, created_at, updated_at)
      VALUES (?, 'pan', ?, ?, 'support', 0.9, '[]', '[]', '[]', 'submitted', ?, datetime('now'), datetime('now'))`).run(id, specialist, specialist, model);
    review('a', 'ollama_seat', 'gemma4:31b:cloud'); review('b', 'claude_seat', 'claude:haiku');
    expect(new PanelCalibrationService(db).compute().map((c) => c.specialistId)).toEqual(['ollama_seat']);
    expect([...specialistAccuracy(db).keys()]).toEqual(['ollama_seat']);
  });
});

describe('INFERENCE_BUDGET_THROTTLE', () => {
  const seed = (db: Database.Database) => {
    recordModelCall(db, { consumer: 'fallback', model: 'kimi-k3:cloud', provider: 'ollama:https://ollama.com', ok: true, latencyMs: 1, outChars: 1, shadow: 0, agree: null, tokensIn: 600, tokensOut: 100 });
    recordModelCall(db, { consumer: 'fallback', model: 'kimi-k3:cloud', provider: 'ollama:https://ollama.com', ok: false, latencyMs: 1, outChars: 0, shadow: 0, agree: null });
    recordModelCall(db, { consumer: 'content_safety', model: 'x', provider: 'nvidia', ok: true, latencyMs: 1, outChars: 0, shadow: 0, agree: null, tokensIn: 9999 });
    db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, repository_path) VALUES ('r', 'test-gap', 'closed', 'completed', '/x')").run();
    const lease = (id: string, runtime: string, meta: Record<string, unknown>) => db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES (?, 'r', 'maker', ?, 'completed', ?)").run(id, runtime, JSON.stringify(meta));
    lease('l1', 'opencode', { model: 'ollama/glm-5.3:cloud', token_accounting: { version: 1, total_tokens: 2300 } });
    lease('l2', 'opencode', { model: 'ollama/glm-5.3:cloud' }); // no accounting: counted apart, not as 0
    lease('l3', 'claude', { model: 'ollama/glm-5.3:cloud', runtime_fallback: { from: 'opencode', to: 'claude' }, token_accounting: { version: 1, total_tokens: 50000 } });
    lease('l4', 'opencode', { model: 'opencode/deepseek-v4.1-flash-free', token_accounting: { version: 1, total_tokens: 70000 } });
  };

  it('tokens over 7 d: Ollama ledger tokens + ollama/* opencode lease totals; a missing table = unknown total', () => {
    const db = freshDb(); seed(db);
    expect(ollamaUsage7d(db)).toEqual({ ledger: { tokens: 700, calls: 2, calls_without_tokens: 1 }, opencode_leases: { tokens: 2300, leases: 2, leases_without_tokens: 1 }, total_tokens: 3000 });
    const bare = new Database(':memory:'); dbs.push(bare);
    expect(ollamaUsage7d(bare)).toEqual({ ledger: null, opencode_leases: null, total_tokens: null });
  });

  it('default shadow, no budget: never pauses, usage_pct null; shadow over the threshold logs only; on pauses', () => {
    const db = freshDb(); seed(db);
    expect(throttleMode({})).toBe('shadow');
    expect(budgetPause(db, 'residents', {})).toBe(false);
    expect(budgetEvidence(db, {})).toMatchObject({ mode: 'shadow', token_budget: null, usage_pct: null, status: 'no_budget', paused: [], would_pause: [] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shadow = { OLLAMA_WEEKLY_TOKEN_BUDGET: '4000' }; // 3000 / 4000 = 0.75 ≥ 0.7
    expect(budgetPause(db, 'dream_evolution', shadow)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(budgetEvidence(db, shadow)).toMatchObject({ usage_pct: 0.75, status: 'over_threshold', paused: [], would_pause: ['dream_evolution', 'frontier_experts', 'residents'] });
    resetBudgetCache();
    const on = { ...shadow, INFERENCE_BUDGET_THROTTLE: 'on' };
    expect(budgetPause(db, 'dream_evolution', on)).toBe(true);
    expect(budgetPause(db, 'dream_evolution', { ...on, OLLAMA_THROTTLE_AT: '0.9' }, Date.now() + 120_000)).toBe(false);
    expect(budgetPause(db, 'residents', { ...on, INFERENCE_BUDGET_THROTTLE: 'off' })).toBe(false);
  });

  it('on over the budget: dream evolution skips its model call', async () => {
    vi.stubEnv('DREAM_EVOLUTION_ENABLED', 'true'); vi.stubEnv('INFERENCE_BUDGET_THROTTLE', 'on'); vi.stubEnv('OLLAMA_WEEKLY_TOKEN_BUDGET', '1000');
    const db = freshDb(); seed(db);
    const call = vi.fn(async () => '{}');
    expect(await dreamOnce(db, Date.now(), call)).toEqual({ created: [], skipped: 'inference_budget' });
    expect(call).not.toHaveBeenCalled();
  });
});

it('evolution evidence: the inference section (failover, panel fallback, budget)', () => {
  const db = freshDb();
  const ev = buildEvolutionEvidence(db, { OLLAMA_AUTO_FAILOVER: 'on' }) as unknown as { inference: Record<string, Record<string, unknown>>; flags: Array<{ name: string }> };
  expect(ev.inference.failover).toMatchObject({ mode: 'on', state: null, effective: 'off', transitions: [] });
  expect(ev.inference.panel_fallback).toMatchObject({ mode: 'off', model: 'claude:haiku', reviews: 0, quarantined: 0 });
  expect(ev.inference.budget).toMatchObject({ mode: 'shadow', status: 'no_budget', usage_pct: null });
  for (const f of ['OLLAMA_AUTO_FAILOVER', 'PANEL_FALLBACK_RUNTIME', 'INFERENCE_BUDGET_THROTTLE', 'OLLAMA_WEEKLY_TOKEN_BUDGET', 'OLLAMA_THROTTLE_AT']) expect(ev.flags.map((x) => x.name)).toContain(f);
});
