// OLLAMA_OUTAGE_FALLBACK_RUNTIME (operator 18-10): Ollama Cloud's weekly limit made every opencode maker time out and every
// reviewer exit 1 (false regressions). With the flag on, opencode production leases run on claude on the Max subscription.
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Task } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { ClaudeExecutor } from '../execution/executors/claude-executor';
import { buildExecutorEnv } from '../execution/executors/executor-env';
import { SUBSCRIPTION_ENV_MARKER } from '../execution/executors/subscription-env';
import { AUTH_MISSING, LIMIT_HIT } from '../services/subscription-gym';
import { makerFailureClass } from '../services/outcome-attribution';
import { verificationFailureOutcome } from '../services/loop-daemon';
import { TG_LOOP } from '../services/tg-001';
import { FALLBACK_REF, TG_LOOP_NAME, applyOutageFallback, outageFallbackRuntime } from '../services/ollama-outage-fallback';
import { ace001Evidence } from '../services/ace-001';
import { ste001Evidence } from '../services/ste-001';
import { effortX1Evidence } from '../services/effort-controller';
import { checkerFamilyEvidence } from '../services/checker-family';
import { makerDeps001Evidence, MAKER_DEPS_001 } from '../services/maker-deps-001';
import { buildEvolutionEvidence, fisherExact } from '../services/evolution-evidence';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';

const roots: string[] = [];
const dbs: Database.Database[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const d of dbs.splice(0)) d.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function fixture(runtime = 'opencode', leaseMeta: Record<string, unknown> = {}, loopName = 'test-gap') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-fallback-')); roots.push(root);
  vi.stubEnv('LOOP_WORKTREE_ROOT', path.join(root, 'worktrees'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-m', 'f'], { cwd: repo, stdio: 'ignore' });
  const db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); dbs.push(db);
  const loops = new LoopService(db, path.join(root, 'evidence'));
  db.prepare("INSERT INTO goals (id, objective, risk_class, status) VALUES ('goal-1', 'Add a test', 'low', 'running')").run();
  db.prepare(`INSERT INTO loop_runs (id,loop_name,mode,status,repository_path,findings_json,metadata,goal_id) VALUES ('run-1',?,'closed','running',?,?,?,'goal-1')`).run(
    loopName, repo, JSON.stringify([{ id: 'finding', type: 'todo_marker', severity: 'low', file: 'README.md', message: 'Add a test', evidence: 'x', suggested_fix: 'y' }]),
    JSON.stringify({ risk_class: 'low' }));
  const assignment = path.join(root, 'assignment.md'); fs.writeFileSync(assignment, 'Fixture assignment');
  loops.insertWorkerLease({ id: 'maker', loopRunId: 'run-1', role: 'maker', runtime, findingId: 'finding', worktreePath: repo, branchName: null,
    now: new Date().toISOString(), metadata: { assignment_file: assignment, ...leaseMeta } });
  vi.spyOn(loops, 'getRuntimeContract').mockReturnValue({ available: true, status: 'ok' } as ReturnType<LoopService['getRuntimeContract']>);
  const calls: Array<{ runtime: string; meta: Record<string, unknown> }> = [];
  const result = { status: 'completed', message: 'ok', stdout: '', stderr: '' };
  const engine = { executeTask: vi.fn(async (taskId: string, rt: string) => {
    const row = db.prepare('SELECT metadata FROM tasks WHERE id = ?').get(taskId) as { metadata: string };
    calls.push({ runtime: rt, meta: JSON.parse(row.metadata) });
    return { status: 'running', completion: Promise.resolve({ ...result }) };
  }) };
  (loops.workerExecutor as unknown as { executionEngine: unknown }).executionEngine = engine;
  return { db, loops, repo, calls, engine, setResult: (r: Partial<typeof result>) => Object.assign(result, r) };
}
const leaseMeta = (db: Database.Database, id: string) => JSON.parse((db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(id) as { metadata: string }).metadata);
const leaseRuntime = (db: Database.Database, id: string) => (db.prepare('SELECT runtime FROM worker_leases WHERE id = ?').get(id) as { runtime: string }).runtime;
const task = { id: 't', description: 'fix the bug' } as Task;

describe('OLLAMA_OUTAGE_FALLBACK_RUNTIME', () => {
  it('flag: unset/anything else = off, claude = on', () => {
    expect(outageFallbackRuntime({})).toBeNull();
    expect(outageFallbackRuntime({ OLLAMA_OUTAGE_FALLBACK_RUNTIME: 'codex' })).toBeNull();
    expect(outageFallbackRuntime({ OLLAMA_OUTAGE_FALLBACK_RUNTIME: 'claude' })).toBe('claude');
    expect(TG_LOOP_NAME).toBe(TG_LOOP);
  });

  it('off: an opencode maker runs exactly as before (opencode, its model, no subscription marker, no fallback stamp)', async () => {
    const f = fixture('opencode', { model: 'ollama/glm-5.2:cloud' });
    await f.loops.executeMaker('run-1', { lease_id: 'maker' });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].runtime).toBe('opencode');
    expect(f.calls[0].meta.model).toBe('ollama/glm-5.2:cloud');
    expect((f.calls[0].meta.environment as Record<string, string>)[SUBSCRIPTION_ENV_MARKER]).toBeUndefined();
    expect(leaseRuntime(f.db, 'maker')).toBe('opencode');
    expect(leaseMeta(f.db, 'maker').runtime_fallback).toBeUndefined();
  });

  it('on: an opencode maker (bandit choice recorded) runs on claude with the subscription marker → acceptEdits, no API keys, OAuth token', async () => {
    vi.stubEnv('OLLAMA_OUTAGE_FALLBACK_RUNTIME', 'claude');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-test');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test'); vi.stubEnv('OPENAI_API_KEY', 'sk-test'); vi.stubEnv('ANTHROPIC_BASE_URL', 'http://proxy');
    const f = fixture('opencode', { model: 'ollama/glm-5.2:cloud', bandit: { reason: 'thompson', posterior: {} } });
    await f.loops.executeMaker('run-1', { lease_id: 'maker' });
    expect(f.calls[0].runtime).toBe('claude');
    expect(f.calls[0].meta.model).toBeUndefined();
    const environment = f.calls[0].meta.environment as Record<string, string>;
    expect(environment[SUBSCRIPTION_ENV_MARKER]).toBe('claude');
    expect(leaseRuntime(f.db, 'maker')).toBe('claude');
    const meta = leaseMeta(f.db, 'maker');
    expect(meta.runtime_fallback).toMatchObject({ from: 'opencode', to: 'claude', reason: 'ollama_outage', from_model: 'ollama/glm-5.2:cloud' });
    expect(meta.bandit).toEqual({ reason: 'thompson', posterior: {} }); // recorded, overridden
    // what the claude executor makes of that task: least-privilege edits, never the bypass, keys stripped, token injected
    vi.stubEnv('CLAUDE_SKIP_PERMISSIONS', 'true');
    const args = new ClaudeExecutor('claude').buildCommand(task, { environment, skipPermissions: true }).args;
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(args).not.toContain('--dangerously-skip-permissions');
    const child = buildExecutorEnv(environment, 'claude');
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_BASE_URL', SUBSCRIPTION_ENV_MARKER]) expect(child[k], k).toBeUndefined();
    expect(child.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-test');
  });

  it('on: never the gym, TG-001, a gym subscription species or a non-opencode runtime', () => {
    const env = { OLLAMA_OUTAGE_FALLBACK_RUNTIME: 'claude' };
    const db = new Database(':memory:'); dbs.push(db);
    const lease = (runtime: string, metadata: Record<string, unknown> = {}) => ({ id: 'x', role: 'maker', runtime, metadata });
    expect(applyOutageFallback(db, { id: 'r', loop_name: 'evolution-gym' }, lease('opencode'), 'opencode', env)).toBe('opencode');
    expect(applyOutageFallback(db, { id: 'r', loop_name: TG_LOOP }, lease('opencode'), 'opencode', env)).toBe('opencode');
    expect(applyOutageFallback(db, { id: 'r', loop_name: 'test-gap' }, lease('opencode', { subscription_auth: 'opencode' }), 'opencode', env)).toBe('opencode');
    for (const rt of ['remote', 'codex', 'mock', 'claude']) expect(applyOutageFallback(db, { id: 'r', loop_name: 'test-gap' }, lease(rt), rt, env)).toBe(rt);
  });

  it('on, no CLAUDE_CODE_OAUTH_TOKEN: never spawned — lease failed infra: subscription_auth_missing (infra_failed, not regressed)', async () => {
    vi.stubEnv('OLLAMA_OUTAGE_FALLBACK_RUNTIME', 'claude');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    const f = fixture('opencode');
    await expect(f.loops.executeMaker('run-1', { lease_id: 'maker' })).rejects.toThrow('SUBSCRIPTION_AUTH_MISSING');
    expect(f.engine.executeTask).not.toHaveBeenCalled();
    const meta = leaseMeta(f.db, 'maker');
    expect(meta.failure_reason).toBe(AUTH_MISSING);
    expect(makerFailureClass(meta)).toBe('infra_failed');
    expect(verificationFailureOutcome(f.db, 'maker', [{ status: 'fail' }])).toBe('infra_failed');
  });

  it('on: a claude usage-limit error → infra: subscription_limit, then every fallback lease is refused during the back-off', async () => {
    vi.stubEnv('OLLAMA_OUTAGE_FALLBACK_RUNTIME', 'claude');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-test');
    const f = fixture('opencode');
    f.setResult({ status: 'failed', stderr: "Claude AI usage limit reached|1760000000" });
    await f.loops.executeMaker('run-1', { lease_id: 'maker' });
    const meta = leaseMeta(f.db, 'maker');
    expect(meta.failure_reason).toBe(LIMIT_HIT);
    expect(typeof meta.subscription_limit_hit_at).toBe('string');
    expect(makerFailureClass(meta)).toBe('infra_failed');
    f.loops.insertWorkerLease({ id: 'maker-2', loopRunId: 'run-1', role: 'maker', runtime: 'opencode', findingId: 'finding', worktreePath: f.repo, branchName: null,
      now: new Date().toISOString(), metadata: { assignment_file: leaseMeta(f.db, 'maker').assignment_file } });
    await expect(f.loops.executeMaker('run-1', { lease_id: 'maker-2' })).rejects.toThrow('SUBSCRIPTION_LIMIT_BACKOFF');
    expect(f.engine.executeTask).toHaveBeenCalledTimes(1);
    expect(leaseMeta(f.db, 'maker-2').failure_reason).toBe(LIMIT_HIT);
  });

  it('on: an opencode checker with an F2 arm runs on claude (subscription marker), its arm becomes fallback_suspended', async () => {
    vi.stubEnv('OLLAMA_OUTAGE_FALLBACK_RUNTIME', 'claude');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-test');
    const f = fixture('opencode');
    await f.loops.executeMaker('run-1', { lease_id: 'maker' });
    f.db.prepare("UPDATE worker_leases SET status = 'completed' WHERE id = 'maker'").run();
    f.loops.insertWorkerLease({ id: 'checker', loopRunId: 'run-1', role: 'checker', runtime: 'manual', findingId: 'finding', worktreePath: null, branchName: null,
      now: new Date().toISOString(), metadata: { maker_lease_id: 'maker', checker_family_arm: 'cross', model: 'ollama/gemma4:31b:cloud', requires_independent_review: true } });
    f.setResult({ status: 'completed', stdout: 'VERDICT: accepted' });
    await f.loops.executeChecker('run-1', { lease_id: 'checker', runtime: 'opencode' });
    const call = f.calls[f.calls.length - 1];
    expect(call.runtime).toBe('claude');
    expect(call.meta.model).toBeUndefined();
    expect((call.meta.environment as Record<string, string>)[SUBSCRIPTION_ENV_MARKER]).toBe('claude');
    expect(leaseRuntime(f.db, 'checker')).toBe('claude');
    expect(leaseMeta(f.db, 'checker')).toMatchObject({ checker_family_arm: 'fallback_suspended',
      runtime_fallback: { from: 'opencode', to: 'claude', reason: 'ollama_outage', from_checker_family_arm: 'cross' } });
  });
});

describe('experiment evidence excludes fallback leases', () => {
  const now = new Date().toISOString();
  const since = new Date(Date.now() - 86_400_000).toISOString();
  function db0() {
    const db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); dbs.push(db);
    new SkillEvolutionEngine(db); // creates skill_outcomes
    return db;
  }
  /** goal + run + maker lease; fallback = the lease carries runtime_fallback */
  function goalRun(db: Database.Database, id: string, goalMeta: Record<string, unknown>, fallback: boolean, status = 'verified') {
    db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, created_at, updated_at)
      VALUES (?, 'feature', 't', 'd', 'r', 'gap_analysis', ?, 0.5, '[]', ?, ?)`).run(`s-${id}`, status, now, now);
    db.prepare("INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES (?, 'o', 'low', 'completed', ?, ?, ?, ?)")
      .run(`g-${id}`, JSON.stringify(goalMeta), `s-${id}`, now, now);
    db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, created_at, updated_at) VALUES (?, ?, 'test-gap', 'closed', 'completed', ?, ?)").run(`r-${id}`, `g-${id}`, now, now);
    db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, 'maker', ?, 'completed', ?, ?, ?)")
      .run(`m-${id}`, `r-${id}`, fallback ? 'claude' : 'opencode', JSON.stringify(fallback ? { runtime_fallback: { from: 'opencode', to: 'claude', reason: 'ollama_outage' } } : {}), now, now);
  }

  it('ACE-001 and STE-001 drop maker outcomes tagged runtime_fallback:ollama_outage', () => {
    const db = db0();
    const out = db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, tokens_used, duration_ms, domain, task_id, agent_id, evidence_refs_json, created_at) VALUES (?, ?, 1, 10, 1, 'test-gap', ?, ?, ?, ?)");
    out.run('o1', 'loop-maker:test-gap:opencode', 'r1', 'm1', JSON.stringify(['ace-001-arm:00', 'ste-001-arm:1']), now);
    out.run('o2', 'loop-maker:test-gap:claude', 'r2', 'm2', JSON.stringify(['ace-001-arm:00', 'ste-001-arm:1', FALLBACK_REF]), now);
    const ste = ste001Evidence(db, since);
    expect(ste.arms['1'].n).toBe(1);
    const ace = ace001Evidence(db, since, { ACE_001_ANALYSIS_SINCE: since }) as unknown as { arms: Record<string, { n: number }> };
    expect(Object.values(ace.arms).reduce((t, a) => t + a.n, 0)).toBe(1);
  });

  it('X1, F2 and MAKER-DEPS-001 drop goals with a fallback lease', () => {
    const db = db0();
    goalRun(db, 'a', { effort_arm: 'on', checker_family_arm: 'same' }, false);
    goalRun(db, 'b', { effort_arm: 'on', checker_family_arm: 'same' }, true);
    expect(effortX1Evidence(db, since, {}, fisherExact).on.goals).toBe(1);
    expect(checkerFamilyEvidence(db, since, {}, fisherExact).same.goals).toBe(1);
    const ev = db.prepare("INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (?, ?, 'maker_deps_arm', 'info', 'm', ?, ?)");
    for (const id of ['a', 'b']) ev.run(`e-${id}`, `r-${id}`, JSON.stringify({ arm: 'A', goal_id: `g-${id}`, experiment: MAKER_DEPS_001.id }), now);
    const md = makerDeps001Evidence(db, since) as unknown as { arms: Record<string, { goals: number }> };
    expect(md.arms.A.goals).toBe(1);
  });

  it('memory holdout drops runs with a fallback lease; the evidence reports the fallback leases', () => {
    const db = db0();
    goalRun(db, 'a', {}, false); goalRun(db, 'b', {}, true);
    const ev = db.prepare("INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (?, ?, 'assignment_context', 'info', 'm', ?, ?)");
    for (const id of ['a', 'b']) ev.run(`e-${id}`, `r-${id}`, JSON.stringify({ examples: [], rule_ids: ['rule-1'] }), now);
    const e = buildEvolutionEvidence(db, { OLLAMA_OUTAGE_FALLBACK_RUNTIME: 'claude' });
    expect(e.memory_holdout.rules.n).toBe(1);
    expect(e.runtime_fallback).toMatchObject({ mode: 'claude', in_backoff: false, by_role: [{ role: 'maker', n: 1, limit_hits: 0, auth_missing: 0 }] });
    expect(e.flags.find((f) => f.name === 'OLLAMA_OUTAGE_FALLBACK_RUNTIME')).toMatchObject({ value: 'claude', acting: true });
  });
});
