import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { EvolutionGymService } from '../services/evolution-gym-service';
import type { GymTask } from '../services/gym-task-miner';
import type { LoopService } from '../services/loop-service';
import { OpenCodeExecutor } from '../execution/executors/opencode-executor';
import { LoopWorkerExecutorService } from '../services/loop-worker-executor-service';
import { SUBSCRIPTION_ENV_MARKER, isSubscriptionLimit, parseSubscriptionSpecies, subscriptionGymEvidence } from '../services/subscription-gym';
import { costBasis } from '../services/model-selector';

// SUBSCRIPTION_GYM_SPECIES=opencode-free:<model>: OpenCode Zen free models through the opencode CLI's built-in 'opencode'
// provider (no key: the CLI sends apiKey 'public' and drops every paid model). Never a paid model, never a billing key.
const KEYS = ['SUBSCRIPTION_GYM_SPECIES', 'SUBSCRIPTION_GYM_MAX_PER_DAY', 'SUBSCRIPTION_GYM_LIMIT_BACKOFF_MS', 'EVOLUTION_GYM_ENABLED', 'EVOLUTION_GYM_MAX_PER_DAY',
  'LOOP_DAEMON_REPOSITORY_PATH', 'LOOP_EVOLVE_SPECIES', 'LOOP_DAEMON_MAKER_RUNTIME', 'EVOLUTION_GYM_EXTRA_SPECIES', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_HOME',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_API_KEY', 'OPENCODE_API_KEY', 'OPENCODE_OLLAMA_API_KEY', 'OPENCODE_ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  'LLM_COST_BASIS', 'RUNTIME_ENV_PASSTHROUGH', 'OPENCODE_OUTPUT_FORMAT'];
const saved: Record<string, string | undefined> = {};
let tmp: string;
beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocfree-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(tmp, { recursive: true, force: true });
});
const FREE = 'opencode-free:deepseek-v4.1-flash-free';
const KEY = 'opencode@opencode/deepseek-v4.1-flash-free';

describe('opencode-free species values', () => {
  it('only model names ending in -free are accepted; anything else is refused (no paid usage)', () => {
    const r = parseSubscriptionSpecies({ SUBSCRIPTION_GYM_SPECIES: `${FREE}, opencode-free:glm-5.3-flash-free,opencode-free:glm-5.2,opencode-free:big-pickle,opencode-free:../x-free,opencode-free:a/b-free,claude` });
    expect(r.species).toEqual([
      { name: FREE, runtime: 'opencode', model: 'opencode/deepseek-v4.1-flash-free', key: KEY, freeTier: true },
      { name: 'opencode-free:glm-5.3-flash-free', runtime: 'opencode', model: 'opencode/glm-5.3-flash-free', key: 'opencode@opencode/glm-5.3-flash-free', freeTier: true },
      { name: 'claude', runtime: 'claude', key: 'claude' },
    ]);
    expect(r.refused).toEqual(['opencode-free:glm-5.2', 'opencode-free:big-pickle', 'opencode-free:../x-free', 'opencode-free:a/b-free']);
  });

  it('the gym species list: the free species alone while the gym is off; next to (not instead of) the configured opencode species', () => {
    const svc = new EvolutionGymService(new Database(':memory:'), {} as never, { mine: () => [], prepare: vi.fn(), install: () => true, oracle: () => false, changed: () => [] });
    process.env.SUBSCRIPTION_GYM_SPECIES = `${FREE},opencode-free:glm-5.2`;
    expect(svc.species()).toEqual([{ runtime: 'opencode', model: 'opencode/deepseek-v4.1-flash-free', subscription: true }]);
    process.env.EVOLUTION_GYM_ENABLED = 'true'; process.env.EVOLUTION_GYM_EXTRA_SPECIES = 'opencode@opencode/deepseek-v4.1-flash-free,atomic';
    expect(svc.species()).toEqual([{ runtime: 'opencode' }, { runtime: 'atomic' }, { runtime: 'opencode', model: 'opencode/deepseek-v4.1-flash-free', subscription: true }]);
  });

  it('cost basis of the CLI run is free_tier (marginal 0)', () => {
    expect(costBasis('free-tier-cli:opencode', 'opencode/deepseek-v4.1-flash-free')).toBe('free_tier');
  });

  it('FreeTier / free-usage errors from the CLI count as a limit (only on failed runs)', () => {
    expect(isSubscriptionLimit(1, '', 'AI_APICallError: {"type":"error","error":{"type":"FreeUsageLimitError","message":"x"}}')).toBe(true);
    expect(isSubscriptionLimit(1, '{"type":"error","message":"Free usage exceeded, subscribe to Go"}', '')).toBe(true);
    expect(isSubscriptionLimit(1, '', 'FreeTierError: model can only be used from within OpenCode')).toBe(true);
    expect(isSubscriptionLimit(0, 'handled FreeTierError in the route', '')).toBe(false);
  });
});

describe('child env of an opencode-free maker', () => {
  function fakeOpencode(): string {
    const bin = path.join(tmp, 'opencode');
    fs.writeFileSync(bin, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: JSON.stringify({ keys: Object.keys(process.env), args: process.argv.slice(2) }) } }) + '\\n');\n`);
    fs.chmodSync(bin, 0o755);
    return bin;
  }
  it('a fake opencode binary gets --model opencode/<model> and sees no Ollama/OpenAI/Anthropic/OpenCode key', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant'; process.env.OPENAI_API_KEY = 'sk-oai'; process.env.OLLAMA_API_KEY = 'ol'; process.env.OPENCODE_OLLAMA_API_KEY = 'oc-ol';
    process.env.OPENCODE_API_KEY = 'zen-paid'; process.env.ANTHROPIC_BASE_URL = 'http://proxy';
    process.env.RUNTIME_ENV_PASSTHROUGH = 'OPENCODE_API_KEY,OLLAMA_API_KEY'; process.env.OPENCODE_OUTPUT_FORMAT = 'json';
    const task = { id: 't1', title: 't', description: 'fix it', status: 'running', priority: 'medium', metadata: {} } as never;
    const session = await new OpenCodeExecutor(fakeOpencode()).start(task, { workingDirectory: tmp, model: 'opencode/deepseek-v4.1-flash-free', environment: { [SUBSCRIPTION_ENV_MARKER]: 'opencode' } });
    for await (const _ of session.events) { /* drain */ }
    const out = (await session.result) as { stdout?: string };
    const seen = JSON.parse((JSON.parse((out.stdout || '').trim().split('\n').pop()!) as { part: { text: string } }).part.text) as { keys: string[]; args: string[] };
    expect(seen.keys.filter((k) => /API_KEY|AUTH_TOKEN|ANTHROPIC_BASE_URL|DJIMITFLO_SUBSCRIPTION/.test(k))).toEqual([]);
    expect(seen.args).toEqual(expect.arrayContaining(['run', '--model', 'opencode/deepseek-v4.1-flash-free']));
  });

  it('the loop worker sets the marker on an opencode gym maker lease only', async () => {
    const db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
    const loop = { buildNestedSpawnEnv: () => undefined, isHighRiskRun: () => false, patchWorkerLeaseMetadata: () => {}, updateWorkerLeaseStatus: () => {} };
    const engine = { executeTask: vi.fn(async () => ({ status: 'denied', reason: 'test' })) };
    const w = new LoopWorkerExecutorService(db, loop as never, engine as never) as unknown as { executeViaEngine: (...a: unknown[]) => Promise<unknown> };
    const env = () => JSON.parse((db.prepare('SELECT metadata FROM tasks ORDER BY rowid DESC LIMIT 1').get() as { metadata: string }).metadata).environment;
    const lease = (meta: Record<string, unknown>) => ({ id: 'l-oc', role: 'maker', runtime: 'opencode', metadata: meta });
    await expect(w.executeViaEngine({ id: 'r', loop_name: 'gym' }, lease({ subscription_auth: 'opencode', model: 'opencode/deepseek-v4.1-flash-free' }), 'opencode', 'p', tmp, 1000, false, 'x')).rejects.toThrow('DENIED');
    expect(env()).toEqual({ [SUBSCRIPTION_ENV_MARKER]: 'opencode' });
    await expect(w.executeViaEngine({ id: 'r', loop_name: 'gym' }, lease({ model: 'ollama/kimi-k3' }), 'opencode', 'p', tmp, 1000, false, 'x')).rejects.toThrow('DENIED');
    expect(env()).toEqual({});
    db.close();
  });
});

const TASK: GymTask = { commit: 'c1', source: 'packages/server/src/services/x.ts', tests: ['packages/server/src/__tests__/x.test.ts'], sourceLines: 3 };
describe('opencode-free species in the local gym', () => {
  let db: Database.Database; let n = 0;
  beforeEach(() => { n = 0; db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); });
  afterEach(() => db.close());

  function service(o: { green?: boolean[]; lease?: Record<string, unknown>; stderr?: string } = {}) {
    const stderrPath = path.join(tmp, `stderr-${Math.random()}.log`); fs.writeFileSync(stderrPath, o.stderr ?? '');
    const stdoutPath = path.join(tmp, `stdout-${Math.random()}.log`); fs.writeFileSync(stdoutPath, '{"type":"step_finish","part":{"type":"step-finish","reason":"stop","tokens":{"total":30}}}\n');
    const loops = {
      startLoop: vi.fn(() => { const id = `run-${++n}`; db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, metadata, created_at) VALUES (?, 'doc-drift-and-small-fix-loop', 'closed', 'running', '{}', ?)").run(id, new Date().toISOString()); return { id }; }),
      continueLoopRun: vi.fn((runId: string) => {
        db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES (?, ?, 'maker', 'opencode', 'prepared', '{}')").run(`m-${runId}`, runId);
        return { leases: [{ id: `m-${runId}`, role: 'maker', worktree_path: '/tmp/none' }] };
      }),
      executeWorker: vi.fn(async (runId: string) => {
        const meta = { exit_status: 0, stdout_path: stdoutPath, stderr_path: stderrPath, runtime_usage: { total_tokens: 30 },
          token_accounting: { input_tokens: 10, output_tokens: 20, duration_ms: 5000 }, ...(o.lease ?? {}) };
        db.prepare("UPDATE worker_leases SET metadata = json_patch(metadata, ?) WHERE id = ?").run(JSON.stringify(meta), `m-${runId}`);
        return {};
      }),
      decideWorkerApproval: vi.fn(async () => null), awaitWorkerExecution: vi.fn(async () => 'completed'),
    };
    const oracle = vi.fn(); for (const g of o.green ?? [false, true]) oracle.mockReturnValueOnce(g);
    const svc = new EvolutionGymService(db, loops as unknown as LoopService, {
      mine: () => [TASK, { ...TASK, commit: 'c2' }, { ...TASK, commit: 'c3' }], prepare: vi.fn(), install: () => true, oracle, changed: () => [TASK.source],
    });
    return { svc, loops };
  }
  const arm = () => { process.env.SUBSCRIPTION_GYM_SPECIES = FREE; process.env.LOOP_DAEMON_REPOSITORY_PATH = '/repo'; };

  it('runs without any login, passes model opencode/<model>, scores under loop-maker:gym:opencode and records a free_tier call', async () => {
    arm();
    const { svc, loops } = service();
    expect(await svc.runOne()).toMatchObject({ status: 'success', species: KEY });
    expect(loops.continueLoopRun).toHaveBeenCalledWith('run-1', expect.objectContaining({ runtime: 'opencode', model: 'opencode/deepseek-v4.1-flash-free' }));
    expect(db.prepare("SELECT json_extract(metadata, '$.subscription_auth') AS a FROM worker_leases").get()).toEqual({ a: 'opencode' });
    expect(db.prepare('SELECT skill_id, model, success FROM skill_outcomes').all()).toEqual([{ skill_id: 'loop-maker:gym:opencode', model: 'opencode/deepseek-v4.1-flash-free', success: 1 }]);
    expect(db.prepare('SELECT model, provider, ok, tokens_in, tokens_out, cost_basis, marginal_cost FROM llm_model_calls').all()).toEqual([{
      model: 'opencode/deepseek-v4.1-flash-free', provider: 'free-tier-cli:opencode', ok: 1, tokens_in: 10, tokens_out: 20, cost_basis: 'free_tier', marginal_cost: 0 }]);
  });

  it('own per-species cap (SUBSCRIPTION_GYM_MAX_PER_DAY); its outcomes do not count against the main gym cap of the plain opencode species', async () => {
    arm(); process.env.SUBSCRIPTION_GYM_MAX_PER_DAY = '1';
    const { svc } = service({ green: [false, true, false, true] });
    expect((await svc.runOne()).status).toBe('success');
    expect(await svc.runOne()).toMatchObject({ status: 'skipped', reason: 'daily cap reached' });
    // the main gym (cap 1) still has room for the plain opencode species: the free species' outcome is not counted there
    process.env.EVOLUTION_GYM_ENABLED = 'true'; process.env.EVOLUTION_GYM_MAX_PER_DAY = '1';
    expect(svc.species()).toHaveLength(2);
    expect(await svc.runOne()).toMatchObject({ status: 'success', species: 'opencode' });
  });

  it('FreeUsageLimitError → infra discard subscription_limit, no outcome, back-off', async () => {
    arm();
    const { svc } = service({ lease: { exit_status: 1, runtime_usage: { total_tokens: 0 } }, stderr: 'Error: {"type":"FreeUsageLimitError","message":"Free usage exceeded, subscribe to Go"}' });
    expect(await svc.runOne()).toMatchObject({ status: 'discarded', reason: 'infra: subscription_limit', species: KEY });
    expect(db.prepare('SELECT COUNT(*) AS n FROM skill_outcomes').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT status, cost_basis, marginal_cost FROM llm_model_calls').all()).toEqual([{ status: 'subscription_limit', cost_basis: 'free_tier', marginal_cost: 0 }]);
    expect(await svc.runOne()).toMatchObject({ status: 'skipped', reason: 'subscription limit back-off' });
  });

  it('evidence under gym_prod_gates.subscription_species: the free species by name, refused values listed, rate null below 10 scored', async () => {
    arm(); process.env.SUBSCRIPTION_GYM_SPECIES = `${FREE},opencode-free:glm-5.2`;
    await service().svc.runOne();
    const ev = subscriptionGymEvidence(db, new Date(Date.now() - 86_400_000).toISOString());
    expect(ev.refused).toEqual(['opencode-free:glm-5.2']);
    expect(ev.species.find((s) => s.species === FREE)).toMatchObject({ enabled: true, key: KEY, cost_basis: 'free_tier', attempts: 1, scored: 1, successes: 1, rate: null, status: 'insufficient' });
    expect(ev.species.find((s) => s.species === 'claude')).toMatchObject({ enabled: false, cost_basis: 'flat_subscription' });
  });
});
