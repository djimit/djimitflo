import { createHash } from 'crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { RemoteGymService } from '../services/remote-gym-service';
import { gymObservations } from '../services/gym-irt';
import type { FailureTask } from '../services/gym-failure-tasks';
import { TG_GENERATION, TG_ID, TG_LOOP, TG_PLAN_ID, TG_R1, canonicalJson, claimTg001, freezeTg001, recordTg001, tg001Evidence, tgGoChecklist, tgManifest, tgPlanDiff,
  type TgPlanRecord } from '../services/tg-001';

/**
 * TG-001 r2 (docs/research/ace/TG-001_R1_INCIDENT.md): r1 was lost to a provider snapshot rollback (ABORTED_DATA_LOSS). r2 reuses
 * only the frozen plan; every attempt/claim/result key carries the generation, other generations are never served or settled,
 * and GO requires plan_matches_r1.
 */
let db: Database.Database;
const NOW = '2026-10-11T12:00:00.000Z';
const FINDING = { id: 'f1', type: 'test_gap', severity: 'low', message: 'wN.ts exports parse() without a unit test.', evidence: 'scan', suggested_fix: 'Write the test.', metadata: { objective_mode: true } };
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

function seedTasks(d: Database.Database, n = 10, fix = FINDING.suggested_fix): FailureTask[] {
  return Array.from({ length: n }, (_, j) => {
    const i = j + 1; const runId = `run-${i}`;
    d.prepare('INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(runId, 'test-gap-loop', 'closed', 'completed', JSON.stringify([{ ...FINDING, suggested_fix: i === 1 ? fix : FINDING.suggested_fix, file: `packages/server/src/services/w${i}.ts` }]), '{}', NOW, NOW);
    d.prepare('INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`lease-${i}`, runId, 'maker', 'remote', 'failed', 'f1', '{}', NOW, NOW);
    return { commit: `fail:${runId}`, kind: 'write_test', base: 'a'.repeat(40), source: `packages/server/src/__tests__/w${i}.test.ts`, tests: [`packages/server/src/__tests__/w${i}.test.ts`],
      target: `packages/server/src/services/w${i}.ts`, sourceLines: 10, run_id: runId, lane: 'exports', mutants: [{ key: `mut:a:w${i}:1:1`, content: 'x' }], oracle: 'o' } as FailureTask;
  });
}
const fresh = () => { const d = new Database(':memory:'); d.pragma('foreign_keys = OFF'); d.exec(schema); runMigrations(d); return d; };
function frozenRecord(d: Database.Database, opts: { now?: string; commit?: string; harness?: string; species?: string; fix?: string } = {}) {
  const tasks = seedTasks(d, 10, opts.fix);
  const r = freezeTg001(d, tasks, { checkoutPath: '/x', species: opts.species ?? 'atomic@llama-router', commit: opts.commit ?? 'c0', harness: opts.harness ?? 'h0', prodGates: { lint: true }, reserved: new Set(), now: opts.now ?? NOW }, {});
  expect(r.frozen).toBe(true);
  return { manifest: r.manifest!, record: tgGoChecklist(d, { commit: opts.commit ?? 'c0', build_id: 'b', worker_sha256: opts.harness ?? 'h0' }, {}, NOW).record! };
}

beforeEach(() => { db = fresh(); });
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

it('fingerprints for identical inputs are unchanged by the generation (values computed on main 4e136f4f)', () => {
  const { record, manifest } = frozenRecord(db);
  expect(manifest.analysis!.experiment_id).toBe(TG_PLAN_ID); // the generation stays outside the hashed analysis
  expect(record.analysis_fingerprint).toBe('f44446ed2170a64bc783ab9366b5db65c4b427bbe6a32a97a7cf0f92cf4b7b9a');
  expect(record.task_set_fingerprint).toBe('95095026714e31f78eea91654a408dd175964e2310f50cc3c459f680a88faa53');
  expect(record.prompt_fingerprints).toEqual({ A: 'd130e108b85e92317ec97a1890bcc98365d80c35dc1edf7aeea05bca308c7974', B: '834132cfe6acf9f956dfa1086a124da69bc2b43ecfb980554e2c17575986b3f0',
    C: 'de4b9e549ab94d13b0559de9a22f08b7a836017166a89af77cec2e93b142293a', D: '98501f4baaefe205335e6e8fddf902bd310d89b099bdc6f0227e51234a14872d' });
  expect(record.gate_version).toBe('275c3f302a689d64b4af73fed411136ae4fa1fdde5537222a9af5893170226cd');
});

it('the generation is in every attempt/claim/result key; the claim and the run carry it', () => {
  vi.stubEnv('EVOLUTION_GYM_REMOTE_ENABLED', 'true'); vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', '/repo-that-does-not-exist');
  vi.stubEnv('TG_001_MODE', 'on'); vi.stubEnv('GYM_PROD_GATES', 'true'); vi.stubEnv('GYM_FAILURE_TASKS_ENABLED', 'true'); vi.stubEnv('EVOLUTION_GYM_REMOTE_MAX_PER_DAY', '1000');
  const svc = new RemoteGymService(db, () => []); const tasks = seedTasks(db); svc.failureTasks = () => tasks;
  const caps = { capabilities: ['write_test', 'prod_gates', 'prompt_override'] };
  const f = svc.claim('workstation', ['atomic@llama-router'], new Date('2026-10-12T01:00:00Z'), caps) as { runId?: string };
  if (f.runId) svc.record(f.runId, 'workstation', { status: 'discarded', reason: 'task: not part of the experiment' });
  const m = tgManifest(db)!;
  expect([TG_ID, TG_GENERATION, m.id, m.generation]).toEqual(['tg-001-r2', 'r2', 'tg-001-r2', 'r2']);
  expect(db.prepare('SELECT id FROM tg_experiments').all()).toEqual([{ id: 'tg-001-r2' }]); // no r1 row is ever written
  const rows = db.prepare('SELECT id, experiment_id FROM tg_attempts').all() as Array<{ id: string; experiment_id: string }>;
  expect(rows.length).toBe(40);
  for (const r of rows) { expect(r.experiment_id).toBe('tg-001-r2'); expect(r.id).toMatch(/^tg-001-r2:[0-9a-f-]{36}$/); }
  const c = svc.claim('workstation', ['atomic@llama-router'], new Date('2026-10-12T01:01:00Z'), caps) as { runId: string; tg: { experiment: string; generation: string; arm: string } };
  expect(c.tg).toMatchObject({ experiment: 'tg-001-r2', generation: 'r2' });
  const run = db.prepare("SELECT loop_name, json_extract(metadata, '$.gym.tg') AS tg FROM loop_runs WHERE id = ?").get(c.runId) as { loop_name: string; tg: string };
  expect(run.loop_name).toBe(TG_LOOP); // provenance unchanged: never 'evolution-gym'
  expect(JSON.parse(run.tg)).toMatchObject({ experiment: 'tg-001-r2', generation: 'r2', attempt_id: expect.stringMatching(/^tg-001-r2:/) });
  svc.record(c.runId, 'workstation', { status: 'failure', reason: 'tests still red' });
  const settled = db.prepare('SELECT result_json FROM tg_attempts WHERE run_id = ?').get(c.runId) as { result_json: string };
  expect(JSON.parse(settled.result_json)).toMatchObject({ generation: 'r2', run_id: c.runId });
  expect(gymObservations(db).length).toBe(0); // isolation: TG runs never reach gym statistics
});

it('a result for a run of another generation is rejected (409) and a pre-restore claim never resumes', () => {
  vi.stubEnv('EVOLUTION_GYM_REMOTE_ENABLED', 'true'); vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', '/repo-that-does-not-exist');
  vi.stubEnv('TG_001_MODE', 'on'); vi.stubEnv('GYM_PROD_GATES', 'true'); vi.stubEnv('GYM_FAILURE_TASKS_ENABLED', 'true'); vi.stubEnv('EVOLUTION_GYM_REMOTE_MAX_PER_DAY', '1000');
  // an r1-shaped run still 'running' (claimed before a restore) and its claimed + pending r1 attempts
  db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, metadata, created_at, updated_at) VALUES ('old-run', ?, 'closed', 'running', ?, ?, ?)")
    .run(TG_LOOP, JSON.stringify({ gym: { commit: 'fail:run-1', species: 'atomic@llama-router', remote_host: 'workstation', tg: { experiment: 'tg-001', arm: 'A', attempt_id: 'r1-att' } } }), NOW, NOW);
  db.prepare("INSERT INTO tg_attempts (id, experiment_id, task_key, arm, seq, status, retries, run_id, updated_at) VALUES ('r1-att', 'tg-001', 'fail:run-1', 'A', 0, 'claimed', 0, 'old-run', ?)").run(NOW);
  db.prepare("INSERT INTO tg_attempts (id, experiment_id, task_key, arm, seq, status, retries, updated_at) VALUES ('r1-pending', 'tg-001', 'fail:run-1', 'B', -1, 'pending', 0, ?)").run(NOW);
  const svc = new RemoteGymService(db, () => []);
  expect(() => svc.record('old-run', 'workstation', { status: 'success', reason: 'tests green' })).toThrow('GYM_RUN_STALE_GENERATION');
  recordTg001(db, 'r1-att', 'old-run', { status: 'success', reason: 'tests green' }, NOW); // the bookkeeping never settles it either
  expect(db.prepare("SELECT status, result_json FROM tg_attempts WHERE id = 'r1-att'").get()).toEqual({ status: 'claimed', result_json: null });
  // r2 freezes and serves only its own rows (the pending r1 row at seq -1 would come first if it were eligible)
  const { manifest } = frozenRecord(db);
  const next = claimTg001(db, manifest, 'new-run', '2026-10-12T02:00:00Z')!;
  expect(next.attempt_id).toMatch(/^tg-001-r2:/);
  expect(claimTg001(db, { ...manifest, id: 'tg-001' }, 'x', '2026-10-12T02:00:00Z')).toBeNull();
  expect(db.prepare("SELECT status FROM tg_attempts WHERE id = 'r1-pending'").get()).toEqual({ status: 'pending' });
});

it('plan_matches_r1: identical plan → no difference; a changed plan names exactly the differing fields; GO requires it', () => {
  // "r1": frozen at an exact millisecond, with another commit and worker
  const r1db = fresh();
  const r1 = frozenRecord(r1db, { now: '2026-10-11T12:00:00.437Z', commit: 'c-r1', harness: 'h-r1' });
  const asR1: TgPlanRecord = { ...r1.record, analysis_fingerprint: sha(canonicalJson(r1.manifest.analysis)), frozen_at: '2026-10-11T12:00:00.437Z', git_commit: 'c-r1', worker_version: 'h-r1' };
  r1db.close();
  // r2: same tasks, prompts and seed, frozen later on another commit and worker → same plan
  const same = frozenRecord(db, { now: '2026-10-12T09:30:00.000Z', commit: 'c-r2', harness: 'h-r2' });
  expect(same.record.analysis_fingerprint).not.toBe(asR1.analysis_fingerprint); // frozen_at/commit/worker are in the analysis
  expect(tgPlanDiff(same.manifest, same.record, asR1)).toEqual([]);
  // exact single re-hash: a frozen_at 1 ms off (or without milliseconds) no longer matches
  expect(tgPlanDiff(same.manifest, same.record, { ...asR1, frozen_at: '2026-10-11T12:00:00.436Z' })).toEqual(['analysis_fingerprint']);
  expect(tgPlanDiff(same.manifest, same.record, { ...asR1, frozen_at: '2026-10-11T12:00:00.438Z' })).toEqual(['analysis_fingerprint']);
  expect(tgPlanDiff(same.manifest, same.record, { ...asR1, frozen_at: '2026-10-11T12:00:00Z' })).toEqual(['analysis_fingerprint']);
  // another model router and one changed production finding → named, nothing else
  const d2 = fresh();
  const diff = frozenRecord(d2, { now: '2026-10-12T09:30:00.000Z', species: 'atomic@other', fix: 'Write a different test.' });
  expect(tgPlanDiff(diff.manifest, diff.record, asR1)).toEqual(['analysis_fingerprint', 'prompt_fingerprints.B', 'prompt_fingerprints.C', 'prompt_fingerprints.D', 'model_router']);
  d2.close();
  // against the real r1 record this fixture is a different plan: no GO, and the checklist says which fields differ
  const go = tgGoChecklist(db, { commit: 'c-r2', build_id: 'b', worker_sha256: 'h-r2' }, {}, '2026-10-12T09:31:00.000Z');
  expect(go.checks.plan_matches_r1).toBe(false);
  expect(go.go).toBe(false);
  expect(go.plan_reuse.differs).toEqual(['analysis_fingerprint', 'task_set_fingerprint', 'prompt_fingerprints.A', 'prompt_fingerprints.B', 'prompt_fingerprints.C', 'prompt_fingerprints.D', 'gate_version']);
  expect(go.plan_reuse.recorded_separately).toEqual({ git_commit: { r1: TG_R1.git_commit, current: 'c-r2' }, worker_version: { r1: TG_R1.worker_version, current: 'h-r2' } });
});

it('r1 is a read-only ABORTED_DATA_LOSS record in the evidence and never counted in the analysis', () => {
  const { manifest } = frozenRecord(db);
  const key = manifest.tasks[0].key;
  // a stray r1-generation row with an outcome (e.g. from a later reconcile) must not be pooled
  db.prepare("INSERT INTO tg_attempts (id, experiment_id, task_key, arm, seq, status, retries, result_json, updated_at) VALUES ('r1-done', 'tg-001', ?, 'A', 0, 'done', 0, ?, ?)")
    .run(key, JSON.stringify({ status: 'success', failure: null, duration_ms: 1, metrics: {} }), NOW);
  const ev = tg001Evidence(db, {}) as unknown as { experiment_id: string; generation: string; prior_generations: Array<Record<string, unknown>>; arms: Array<{ arm: string; n: number; pending: number }> };
  expect(ev).toMatchObject({ experiment_id: 'tg-001-r2', generation: 'r2' });
  expect(ev.prior_generations).toHaveLength(1);
  expect(ev.prior_generations[0]).toMatchObject({ generation: 'r1', status: 'ABORTED_DATA_LOSS', frozen_at: '2026-10-11T23:04:15.146Z', first_attempt_at: '2026-10-11T23:25:18.735Z',
    attempts_executed: '~5 UNKNOWN/LOST', pooled: false, analysis_fingerprint: 'ff29c34441f68804b0177b0599f673f369386e139234662eeb33f23d234e70ec' });
  expect(ev.arms.find((a) => a.arm === 'A')).toMatchObject({ n: 0, pending: 10 }); // the r1 row is not an observation
  expect(tg001Evidence(fresh(), {})).toMatchObject({ status: 'not_frozen', generation: 'r2', prior_generations: [expect.objectContaining({ status: 'ABORTED_DATA_LOSS' })] });
});
