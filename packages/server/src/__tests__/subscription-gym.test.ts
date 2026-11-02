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
import { buildExecutorEnv } from '../execution/executors/executor-env';
import { ClaudeExecutor } from '../execution/executors/claude-executor';
import { CodexExecutor } from '../execution/executors/codex-executor';
import { LoopWorkerExecutorService } from '../services/loop-worker-executor-service';
import { chooseSpecies } from '../services/runtime-bandit';
import { SUBSCRIPTION_ENV_MARKER, codexAuthFile, isSubscriptionLimit, subscriptionGymEvidence } from '../services/subscription-gym';
import { buildEvolutionEvidence, EVOLUTION_FLAGS } from '../services/evolution-evidence';

const KEYS = ['SUBSCRIPTION_GYM_SPECIES', 'SUBSCRIPTION_GYM_MAX_PER_DAY', 'SUBSCRIPTION_GYM_LIMIT_BACKOFF_MS', 'EVOLUTION_GYM_ENABLED', 'LOOP_DAEMON_REPOSITORY_PATH',
  'LOOP_EVOLVE_SPECIES', 'LOOP_DAEMON_MAKER_RUNTIME', 'EVOLUTION_GYM_EXTRA_SPECIES', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_HOME', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
  'OPENCODE_OPENAI_API_KEY', 'OPENCODE_ANTHROPIC_API_KEY', 'LLM_COST_BASIS', 'RUNTIME_ENV_PASSTHROUGH'];
const saved: Record<string, string | undefined> = {};
let tmp: string;
beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subgym-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(tmp, { recursive: true, force: true });
});
const billing = () => { process.env.ANTHROPIC_API_KEY = 'sk-ant-api'; process.env.OPENAI_API_KEY = 'sk-openai'; process.env.OPENCODE_OPENAI_API_KEY = 'oc-key'; process.env.OPENCODE_ANTHROPIC_API_KEY = 'oc-ant'; };

describe('child env of a subscription maker', () => {
  it('drops every billing key and adds the claude login only when the marker names the executor; unmarked env unchanged', () => {
    billing(); process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-secret'; process.env.RUNTIME_ENV_PASSTHROUGH = 'ANTHROPIC_API_KEY,OPENAI_API_KEY';
    const sub = buildExecutorEnv({ [SUBSCRIPTION_ENV_MARKER]: 'claude' }, 'claude');
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENCODE_OPENAI_API_KEY', 'OPENCODE_ANTHROPIC_API_KEY', SUBSCRIPTION_ENV_MARKER]) expect(sub[k]).toBeUndefined();
    expect(sub.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-secret');
    expect(sub.PATH).toBe(process.env.PATH);
    const mismatch = buildExecutorEnv({ [SUBSCRIPTION_ENV_MARKER]: 'claude' }, 'codex');
    expect(mismatch.ANTHROPIC_API_KEY).toBeUndefined(); expect(mismatch.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    const plain = buildExecutorEnv(undefined, 'claude');
    expect(plain.ANTHROPIC_API_KEY).toBe('sk-ant-api'); expect(plain.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined(); // production makers unchanged
  });

  function fakeCli(name: string): string {
    const bin = path.join(tmp, name);
    fs.writeFileSync(bin, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ keys: Object.keys(process.env), oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'present' : 'absent', codex_home: process.env.CODEX_HOME || null }) + '\\n');\n`);
    fs.chmodSync(bin, 0o755);
    return bin;
  }
  const run = async (exec: ClaudeExecutor | CodexExecutor) => {
    const task = { id: 't1', title: 't', description: 'fix it', status: 'running', priority: 'medium', metadata: {} } as never;
    const session = await exec.start(task, { workingDirectory: tmp, environment: { [SUBSCRIPTION_ENV_MARKER]: exec.kind } });
    for await (const _ of session.events) { /* drain */ }
    const out = (await session.result) as { stdout?: string };
    return JSON.parse((out.stdout || '').trim().split('\n').pop()!) as { keys: string[]; oauth: string; codex_home: string | null };
  };
  it('a fake claude binary sees no API key and the OAuth token; a fake codex sees no API key and CODEX_HOME', async () => {
    billing(); process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-secret'; process.env.CODEX_HOME = path.join(tmp, 'codex-home');
    const claude = await run(new ClaudeExecutor(fakeCli('claude')));
    expect(claude.keys.filter((k) => /API_KEY/.test(k))).toEqual([]);
    expect(claude.oauth).toBe('present');
    const codex = await run(new CodexExecutor(fakeCli('codex')));
    expect(codex.keys.filter((k) => /API_KEY/.test(k))).toEqual([]);
    expect(codex.oauth).toBe('absent'); expect(codex.codex_home).toBe(process.env.CODEX_HOME);
  });

  it('the loop worker marks only a subscription gym maker of the same runtime (the token itself is never stored)', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-secret';
    const db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
    const loop = { buildNestedSpawnEnv: () => undefined, isHighRiskRun: () => false, patchWorkerLeaseMetadata: () => {}, updateWorkerLeaseStatus: () => {} };
    const engine = { executeTask: vi.fn(async () => ({ status: 'denied', reason: 'test' })) };
    const w = new LoopWorkerExecutorService(db, loop as never, engine as never) as unknown as { executeViaEngine: (...a: unknown[]) => Promise<unknown> };
    const env = () => (db.prepare('SELECT metadata FROM tasks ORDER BY rowid DESC LIMIT 1').get() as { metadata: string }).metadata;
    const lease = (runtime: string, meta: Record<string, unknown>) => ({ id: `l-${runtime}`, role: 'maker', runtime, metadata: meta });
    await expect(w.executeViaEngine({ id: 'r', loop_name: 'gym' }, lease('claude', { subscription_auth: 'claude' }), 'claude', 'p', tmp, 1000, false, 'x')).rejects.toThrow('DENIED');
    expect(JSON.parse(env()).environment).toEqual({ [SUBSCRIPTION_ENV_MARKER]: 'claude' });
    expect(env()).not.toContain('oauth-secret');
    await expect(w.executeViaEngine({ id: 'r', loop_name: 'gym' }, lease('claude', {}), 'claude', 'p', tmp, 1000, false, 'x')).rejects.toThrow('DENIED');
    expect(JSON.parse(env()).environment).toEqual({});
    db.close();
  });
});

const TASK: GymTask = { commit: 'c1', source: 'packages/server/src/services/x.ts', tests: ['packages/server/src/__tests__/x.test.ts'], sourceLines: 3 };
describe('subscription species in the local gym', () => {
  let db: Database.Database; let n = 0;
  beforeEach(() => { n = 0; db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); });
  afterEach(() => db.close());

  function service(o: { green?: boolean[]; lease?: Record<string, unknown>; stderr?: string } = {}) {
    const stderrPath = path.join(tmp, `stderr-${Math.random()}.log`); fs.writeFileSync(stderrPath, o.stderr ?? '');
    const stdoutPath = path.join(tmp, `stdout-${Math.random()}.log`); fs.writeFileSync(stdoutPath, '{"type":"result","duration_ms":4321,"usage":{"input_tokens":10,"output_tokens":20}}\n');
    const loops = {
      startLoop: vi.fn(() => { const id = `run-${++n}`; db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, metadata, created_at) VALUES (?, 'doc-drift-and-small-fix-loop', 'closed', 'running', '{}', ?)").run(id, new Date().toISOString()); return { id }; }),
      continueLoopRun: vi.fn((runId: string) => {
        db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES (?, ?, 'maker', 'claude', 'prepared', '{}')").run(`m-${runId}`, runId);
        return { leases: [{ id: `m-${runId}`, role: 'maker', worktree_path: '/tmp/none' }] };
      }),
      // the maker "runs": the executor records its outputs on the lease, as runMaker does
      executeWorker: vi.fn(async (runId: string) => {
        const meta = { exit_status: 0, stdout_path: stdoutPath, stderr_path: stderrPath, runtime_usage: { total_tokens: 30 },
          token_accounting: { input_tokens: 10, output_tokens: 20, model_id: 'claude-sonnet-x', duration_ms: 5000 }, ...(o.lease ?? {}) };
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
  const arm = () => { process.env.SUBSCRIPTION_GYM_SPECIES = 'claude'; process.env.LOOP_DAEMON_REPOSITORY_PATH = '/repo'; process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-secret'; };
  const outcomes = () => db.prepare('SELECT skill_id, success, domain FROM skill_outcomes').all();

  it('species: off by default; SUBSCRIPTION_GYM_SPECIES alone runs only those, and replaces a configured species on the same runtime', () => {
    const { svc } = service();
    expect(svc.species()).toEqual([]);
    process.env.SUBSCRIPTION_GYM_SPECIES = 'claude, codex,bogus';
    expect(svc.species()).toEqual([{ runtime: 'claude', subscription: true }, { runtime: 'codex', subscription: true }]);
    process.env.EVOLUTION_GYM_ENABLED = 'true'; process.env.EVOLUTION_GYM_EXTRA_SPECIES = 'claude,atomic';
    expect(svc.species()).toEqual([{ runtime: 'opencode' }, { runtime: 'atomic' }, { runtime: 'claude', subscription: true }, { runtime: 'codex', subscription: true }]);
  });

  it('a success scores like any gym species, marks the lease and records the CLI usage as a flat subscription', async () => {
    arm();
    const r = await service().svc.runOne();
    expect(r).toMatchObject({ status: 'success', species: 'claude' });
    expect(outcomes()).toEqual([{ skill_id: 'loop-maker:gym:claude', success: 1, domain: 'gym' }]);
    expect(db.prepare("SELECT json_extract(metadata, '$.subscription_auth') AS a FROM worker_leases WHERE id = 'm-run-1'").get()).toEqual({ a: 'claude' });
    expect(db.prepare("SELECT json_extract(metadata, '$.gym.subscription') AS s FROM loop_runs WHERE id = 'run-1'").get()).toEqual({ s: 1 });
    expect(db.prepare('SELECT consumer, model, provider, ok, latency_ms, tokens_in, tokens_out, cost_basis, marginal_cost FROM llm_model_calls').all()).toEqual([{
      consumer: 'evolution_gym', model: 'claude-sonnet-x', provider: 'subscription-cli:claude', ok: 1, latency_ms: 4321, tokens_in: 10, tokens_out: 20, cost_basis: 'flat_subscription', marginal_cost: 0 }]);
    expect(JSON.stringify(db.prepare('SELECT * FROM llm_model_calls').all())).not.toContain('oauth-secret');
  });

  it('missing login → infra discard subscription_auth_missing, nothing spawned (no lease, no maker run)', async () => {
    arm(); delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const { svc, loops } = service();
    expect(await svc.runOne()).toMatchObject({ status: 'discarded', reason: 'infra: subscription_auth_missing' });
    expect(loops.continueLoopRun).not.toHaveBeenCalled(); expect(loops.executeWorker).not.toHaveBeenCalled();
    expect(outcomes()).toEqual([]);
    process.env.SUBSCRIPTION_GYM_SPECIES = 'codex'; process.env.CODEX_HOME = path.join(tmp, 'no-codex');
    expect(codexAuthFile()).toBe(path.join(tmp, 'no-codex', 'auth.json'));
    expect(await svc.runOne()).toMatchObject({ status: 'discarded', reason: 'infra: subscription_auth_missing', species: 'codex' });
    expect(loops.continueLoopRun).not.toHaveBeenCalled();
    // an API-key codex login would bill per token: refused like a missing one; a ChatGPT login runs
    fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
    fs.writeFileSync(codexAuthFile(), JSON.stringify({ OPENAI_API_KEY: 'sk-x', tokens: null }));
    expect(await svc.runOne()).toMatchObject({ reason: 'infra: subscription_auth_missing' });
    fs.writeFileSync(codexAuthFile(), JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: 'x' } }));
    expect((await svc.runOne()).status).toBe('success');
    expect(loops.continueLoopRun).toHaveBeenCalledTimes(1);
    // auth refusals never burn the task for later (a fixed login gets the same tasks)
    expect(db.prepare("SELECT COUNT(*) AS n FROM loop_runs WHERE json_extract(metadata, '$.gym.commit') = 'c1'").get()).toEqual({ n: 4 });
  });

  it('caps attempts per species per day (SUBSCRIPTION_GYM_MAX_PER_DAY, discards included), apart from the main gym cap', async () => {
    arm(); process.env.SUBSCRIPTION_GYM_MAX_PER_DAY = '2';
    const { svc } = service({ green: [false, true, false, true, false, true] });
    expect((await svc.runOne()).status).toBe('success');
    expect((await svc.runOne()).status).toBe('success');
    expect(await svc.runOne()).toMatchObject({ status: 'skipped', reason: 'daily cap reached' });
  });

  it('a CLI usage-limit error → infra discard subscription_limit, no species outcome, then back-off', async () => {
    arm();
    const { svc } = service({ lease: { exit_status: 1, failure_reason: 'maker_gate_failed:maker_runtime_exit_zero' }, stderr: "Claude AI usage limit reached|1760000000" });
    expect(await svc.runOne()).toMatchObject({ status: 'discarded', reason: 'infra: subscription_limit' });
    expect(outcomes()).toEqual([]);
    expect(db.prepare('SELECT ok, status, cost_basis, marginal_cost FROM llm_model_calls').all()).toEqual([{ ok: 0, status: 'subscription_limit', cost_basis: 'flat_subscription', marginal_cost: 0 }]);
    expect(await svc.runOne()).toMatchObject({ status: 'skipped', reason: 'subscription limit back-off' });
    process.env.SUBSCRIPTION_GYM_LIMIT_BACKOFF_MS = '1';
    await new Promise((r) => setTimeout(r, 5));
    expect((await svc.runOne()).status).not.toBe('skipped');
  });

  it('limit detection only on failed runs: a successful fix that mentions rate limits is scored', () => {
    expect(isSubscriptionLimit(0, 'added a rate limit to the route', '')).toBe(false);
    expect(isSubscriptionLimit(1, '', "You've hit your usage limit. Upgrade to Pro")).toBe(true);
    expect(isSubscriptionLimit(1, '{"type":"error","message":"rate_limit_exceeded"}', '')).toBe(true);
    expect(isSubscriptionLimit(1, '', 'TypeError: x is undefined')).toBe(false);
  });

  it('the bandit never reads gym outcomes: subscription species wins in the gym leave production selection untouched', async () => {
    arm();
    const { svc } = service({ green: [false, true, false, true] });
    await svc.runOne(); await svc.runOne();
    expect(outcomes()).toHaveLength(2);
    const choice = chooseSpecies(db, 'doc-drift-and-small-fix-loop', [{ runtime: 'opencode' }, { runtime: 'claude' }]);
    expect(choice?.posterior).toEqual([expect.objectContaining({ species: 'opencode', runs: 0 }), expect.objectContaining({ species: 'claude', runs: 0, ok: 0 })]);
  });

  it('evidence: per species attempts / successes / limit hits under gym_prod_gates; rate insufficient (null, not 0) below 10 scored; flags documented', async () => {
    arm();
    await service().svc.runOne();
    await service({ lease: { exit_status: 1 }, stderr: 'rate limit' }).svc.runOne();
    const ev = subscriptionGymEvidence(db, new Date(Date.now() - 86_400_000).toISOString());
    expect(ev.species.find((s) => s.species === 'claude')).toMatchObject({ enabled: true, attempts: 2, scored: 1, successes: 1, limit_hits: 1, rate: null, ci: null, status: 'insufficient' });
    expect(ev.species.find((s) => s.species === 'codex')).toMatchObject({ enabled: false, attempts: 0 });
    expect((buildEvolutionEvidence(db) as { gym_prod_gates: { subscription_species: unknown } }).gym_prod_gates.subscription_species).toMatchObject({ enabled: ['claude'] });
    expect(EVOLUTION_FLAGS.map((f) => f.name)).toEqual(expect.arrayContaining(['SUBSCRIPTION_GYM_SPECIES', 'SUBSCRIPTION_GYM_MAX_PER_DAY', 'SUBSCRIPTION_GYM_LIMIT_BACKOFF_MS']));
  });
});
