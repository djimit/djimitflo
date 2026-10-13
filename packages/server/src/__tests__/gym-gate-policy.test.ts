import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { RemoteGymService, prodGatesConfig } from '../services/remote-gym-service';
import { buildEvolutionEvidence } from '../services/evolution-evidence';
import { TG_ID, TG_LOOP } from '../services/tg-001';
import type { FailureTask } from '../services/gym-failure-tasks';
import { GATE_POLICY_ID, activeGatePolicyInput, GYM_EVALUATOR_VERSION, attemptGatePolicy, canonicalGateJson, gatePolicyClause, gatePolicyHash, holdoutEpochOf } from '../services/gym-gate-policy';

const TASK = (commit: string) => ({ commit, source: 'packages/server/src/services/x.ts', tests: ['packages/server/src/__tests__/x.test.ts'], sourceLines: 5 });
const GATES = { scripts: ['test:changed', 'lint', 'type-check'], timeout_ms: 300_000, diff_max_lines: 200 };
let db: Database.Database;
const meta = (id: string) => JSON.parse((db.prepare('SELECT metadata FROM loop_runs WHERE id = ?').get(id) as { metadata: string }).metadata);
beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  vi.stubEnv('EVOLUTION_GYM_REMOTE_ENABLED', 'true'); vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', '/repo-that-does-not-exist');
  vi.stubEnv('LOOP_DAEMON_CHECK_SCRIPTS', GATES.scripts.join(',')); vi.stubEnv('LOOP_DAEMON_CHECK_TIMEOUT_MS', String(GATES.timeout_ms));
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

describe('gate-policy hash', () => {
  it('is deterministic (key order is irrelevant), pinned, and changes when any gate config value changes', () => {
    const h = gatePolicyHash(GATES);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(gatePolicyHash({ diff_max_lines: 200, timeout_ms: 300_000, scripts: ['test:changed', 'lint', 'type-check'] })).toBe(h);
    expect(canonicalGateJson({ b: 1, a: { d: 2, c: [{ f: 1, e: 0 }] } })).toBe('{"a":{"c":[{"e":0,"f":1}],"d":2},"b":1}');
    for (const changed of [{ ...GATES, scripts: ['test:changed', 'lint'] }, { ...GATES, scripts: ['lint', 'test:changed', 'type-check'] },
      { ...GATES, timeout_ms: 300_001 }, { ...GATES, diff_max_lines: 400 }]) expect(gatePolicyHash(changed)).not.toBe(h);
    // the hash follows the active prod config (env), so a config change yields a new policy hash
    expect(gatePolicyHash(prodGatesConfig())).toBe(h);
    vi.stubEnv('LOOP_DAEMON_CHECK_SCRIPTS', 'test:changed,lint');
    expect(gatePolicyHash(prodGatesConfig())).not.toBe(h);
  });
  it('activeGatePolicyInput (cycle-free copy for evidence readers) equals remote-gym prodGatesConfig for every env shape', () => {
    for (const env of [{}, { LOOP_DAEMON_CHECK_SCRIPTS: 'a, b ,bad key!,c', LOOP_DAEMON_CHECK_TIMEOUT_MS: '999' }, { LOOP_DAEMON_CHECK_SCRIPTS: Array.from({ length: 12 }, (_, i) => `s${i}`).join(','), LOOP_DAEMON_CHECK_TIMEOUT_MS: '900000' },
      { LOOP_DAEMON_CHECK_SCRIPTS: 'lint', LOOP_DAEMON_CHECK_TIMEOUT_MS: 'x' }]) expect(activeGatePolicyInput(env)).toEqual(prodGatesConfig(env));
  });
  it('the hash of the current canonical policy is pinned (an unintended policy change fails here)', () => {
    expect(gatePolicyHash(GATES)).toBe(PINNED);
  });
});

describe('claim + result binding (non-TG)', () => {
  it('a gated claim records every field; the result echoes the hash with result_at and the per-check gate results', () => {
    vi.stubEnv('GYM_PROD_GATES', 'true'); vi.stubEnv('DJIMITFLO_BUILD_COMMIT', 'abc1234');
    db.prepare("INSERT INTO gym_holdout (commit_sha, created_at, epoch) VALUES ('c1', '2026-10-01T00:00:00Z', 2)").run();
    const svc = new RemoteGymService(db, () => [TASK('c1')]);
    const at = new Date('2026-10-14T10:00:00.000Z');
    const c = svc.claim('workstation', ['atomic@llama-router'], at, { capabilities: ['prod_gates'] }) as { runId: string };
    expect(meta(c.runId).gym.gate_policy).toEqual({ id: GATE_POLICY_ID, hash: gatePolicyHash(GATES), evaluator_version: GYM_EVALUATOR_VERSION, code_sha: 'abc1234',
      attempt_id: c.runId, claimed_at: at.toISOString(), task: 'c1', species: 'atomic@llama-router', gated: true, holdout: { table: 'gym_holdout', epoch: 2 } });
    svc.record(c.runId, 'workstation', { status: 'failure', reason: 'prod_gate_failed:lint', prod_gates: { lint: 'fail', 'type-check': 'pass' } });
    const r = meta(c.runId).gym_result;
    expect(r.gate_policy).toEqual({ id: GATE_POLICY_ID, hash: gatePolicyHash(GATES), result_at: expect.any(String), gate_results: { lint: 'fail', 'type-check': 'pass' } });
    expect(r.prod_gates).toEqual({ lint: 'fail', 'type-check': 'pass' }); // the existing field is unchanged
    const read = attemptGatePolicy(JSON.stringify(meta(c.runId)));
    expect(read).toMatchObject({ status: 'recorded', claim: { attempt_id: c.runId }, result: { hash: gatePolicyHash(GATES) } });
  });
  it('an ungated claim is bound too (gated:false, no holdout field for a non-holdout task)', () => {
    const svc = new RemoteGymService(db, () => [TASK('c9')]);
    const c = svc.claim('workstation', ['atomic'], new Date()) as { runId: string };
    expect(meta(c.runId).gym.gate_policy).toMatchObject({ gated: false, task: 'c9', species: 'atomic', hash: gatePolicyHash(GATES) });
    expect(meta(c.runId).gym.gate_policy.holdout).toBeUndefined();
    expect(holdoutEpochOf(db, 'c9')).toBeUndefined();
  });
});

describe('TG and historical rows', () => {
  it('a TG-001 result path is a no-op: no gate_policy on claim or result, gym_result shape exactly as before', () => {
    const tgMeta = { gym: { commit: 'fail:run-1', kind: 'write_test', species: 'atomic@llama-router', remote_host: 'workstation', prod_gates: 1, tg: { experiment: TG_ID, generation: 'r2', arm: 'A', attempt_id: 'att-1' } } };
    db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, repository_path, metadata, created_at, updated_at) VALUES ('tg-run', ?, 'closed', 'running', '/r', ?, '2026-10-14T00:00:00Z', '2026-10-14T00:00:00Z')")
      .run(TG_LOOP, JSON.stringify(tgMeta));
    new RemoteGymService(db, () => []).record('tg-run', 'workstation', { status: 'success', reason: 'tests green, source only', prod_gates: { lint: 'pass' } });
    const m = meta('tg-run');
    expect(m.gym).toEqual(tgMeta.gym);
    expect(m.gym_result).toEqual({ status: 'success', reason: 'tests green, source only', prod_gates: { lint: 'pass' } });
    expect(attemptGatePolicy(JSON.stringify(m))).toEqual({ status: 'unrecorded' });
  });
  it('a TG-001 claim carries no gate_policy', () => {
    vi.stubEnv('TG_001_MODE', 'on'); vi.stubEnv('GYM_PROD_GATES', 'true'); vi.stubEnv('GYM_FAILURE_TASKS_ENABLED', 'true');
    const NOW = '2026-10-11T12:00:00.000Z';
    const tasks = Array.from({ length: 12 }, (_, j) => {
      const i = j + 1; const runId = `run-${i}`;
      db.prepare('INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(runId, 'test-gap-loop', 'closed', 'completed',
        JSON.stringify([{ id: 'f1', type: 'test_gap', severity: 'low', file: `packages/server/src/services/w${i}.ts`, message: `w${i}.ts exports parse() without a unit test.`, evidence: 'scan', suggested_fix: 'Write the test.', metadata: { objective_mode: true } }]), '{}', NOW, NOW);
      db.prepare('INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(`lease-${i}`, runId, 'maker', 'remote', 'failed', 'f1', '{}', NOW, NOW);
      return { commit: `fail:${runId}`, kind: 'write_test', base: 'a'.repeat(40), source: `packages/server/src/__tests__/w${i}.test.ts`, tests: [`packages/server/src/__tests__/w${i}.test.ts`],
        target: `packages/server/src/services/w${i}.ts`, sourceLines: 10, run_id: runId, lane: i <= 3 ? 'test-gap' : 'exports', mutants: [{ key: `mut:a:w${i}:1:1`, content: 'x' }], oracle: 'o' } as FailureTask;
    });
    const svc = new RemoteGymService(db, () => []); svc.failureTasks = () => tasks;
    const caps = { capabilities: ['canary', 'write_test', 'prod_gates', 'prompt_override'] };
    svc.claim('workstation', ['atomic@llama-router'], new Date(Date.now() - 60_000), caps); // freezes the plan
    db.prepare("UPDATE loop_runs SET status = 'completed' WHERE loop_name = 'evolution-gym'").run();
    const c = svc.claim('workstation', ['atomic@llama-router'], new Date(), caps) as { runId: string; tg?: unknown };
    expect(c.tg).toBeDefined();
    const row = db.prepare('SELECT loop_name, metadata FROM loop_runs WHERE id = ?').get(c.runId) as { loop_name: string; metadata: string };
    expect(row.loop_name).toBe(TG_LOOP);
    expect(row.metadata).not.toContain('gate_policy');
  });
  it('a historical attempt (claimed before the binding) stays unrecorded: its result gets no retrospective hash', () => {
    db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, repository_path, metadata, created_at, updated_at) VALUES ('old', 'evolution-gym', 'closed', 'running', '/r', ?, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')")
      .run(JSON.stringify({ gym: { commit: 'c0', species: 'atomic', remote_host: 'workstation', prod_gates: 1 } }));
    new RemoteGymService(db, () => []).record('old', 'workstation', { status: 'success', reason: 'tests green, source only', prod_gates: { lint: 'pass' } });
    const m = meta('old');
    expect(m.gym.gate_policy).toBeUndefined(); expect(m.gym_result.gate_policy).toBeUndefined();
    expect(attemptGatePolicy(JSON.stringify(m))).toEqual({ status: 'unrecorded' });
    expect(attemptGatePolicy(null)).toEqual({ status: 'unrecorded' });
  });
});

describe('GYM_REQUIRE_GATE_POLICY_HASH (gated-evidence reader)', () => {
  const seed = (id: string, hash?: string) => db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, metadata, created_at, updated_at) VALUES (?, 'evolution-gym', 'closed', 'completed', ?, ?, ?)")
    .run(id, JSON.stringify({ gym: { commit: id, species: 'atomic', prod_gates: 1, ...(hash ? { gate_policy: { hash } } : {}) },
      gym_result: { status: 'success', reason: 'ok', prod_gates: { lint: 'pass' }, ...(hash ? { gate_policy: { hash } } : {}) } }), new Date().toISOString(), new Date().toISOString());
  it('flag off (default): no clause, the reader counts exactly as before and exposes the optional by-hash breakdown', () => {
    seed('u1'); seed('u2'); seed('m1', gatePolicyHash(GATES)); seed('x1', 'f'.repeat(64));
    expect(gatePolicyClause(GATES)).toBe('');
    const ev = buildEvolutionEvidence(db, process.env).gym_prod_gates;
    expect(ev.by_kind).toEqual([expect.objectContaining({ kind: 'mined', scored: 4, prod_gate_success: 4 })]);
    expect(ev.gate_policy).toEqual({ current_hash: gatePolicyHash(GATES), required: false, by_hash: [{ hash: 'unrecorded', n: 2 }, { hash: gatePolicyHash(GATES), n: 1 }, { hash: 'f'.repeat(64), n: 1 }] });
  });
  it('flag on: only attempts bound to the current policy hash (claim and result) are eligible', () => {
    seed('u1'); seed('m1', gatePolicyHash(GATES)); seed('x1', 'f'.repeat(64));
    vi.stubEnv('GYM_REQUIRE_GATE_POLICY_HASH', 'true');
    expect(gatePolicyClause(GATES)).toContain(gatePolicyHash(GATES));
    const ev = buildEvolutionEvidence(db, process.env).gym_prod_gates;
    expect(ev.by_kind).toEqual([expect.objectContaining({ kind: 'mined', scored: 1 })]);
    expect(ev.gate_policy.required).toBe(true);
  });
});

const PINNED = '4040c2e3f42b6437801c67b0d6f6ccac178b4d33531f13ae8c3295805c56d548'; // computed once on this branch; a change is a new policy
