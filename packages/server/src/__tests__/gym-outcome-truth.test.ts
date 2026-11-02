import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { REMOTE_GYM_SCOPE, RemoteGymService, sweepOrphanedGymRuns } from '../services/remote-gym-service';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { triedTasks } from '../services/evolution-gym-service';
import { operatorCockpit } from '../services/operator-cockpit';
import { createRemoteGymRoutes } from '../routes/remote-gym';
import { mintSpawnToken, resolveSpawnTokenSecret } from '../services/spawn-token';

// the route builds its own RemoteGymService, which mines the deploy checkout: hand it one fixed task instead
vi.mock('../services/gym-task-miner', async (orig) => ({
  ...(await orig<typeof import('../services/gym-task-miner')>()),
  mineGymTasks: () => [{ commit: 'h1', source: 'packages/server/src/services/x.ts', tests: ['packages/server/src/__tests__/x.test.ts'], sourceLines: 5 }],
}));

const TASK = (commit: string) => ({ commit, source: 'packages/server/src/services/x.ts', tests: ['packages/server/src/__tests__/x.test.ts'], sourceLines: 5 });
const WIN = { status: 'success' as const, changed_files: ['packages/server/src/services/x.ts'], diff: '+fixed', reason: 'tests green, source only', durationMs: 1000 };
const gymResult = (runId: string) => JSON.parse((db.prepare("SELECT json_extract(metadata, '$.gym_result') AS r FROM loop_runs WHERE id = ?").get(runId) as { r: string | null }).r ?? 'null');
const outcomes = () => db.prepare('SELECT tokens_used FROM skill_outcomes ORDER BY rowid').all();
let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  vi.stubEnv('EVOLUTION_GYM_REMOTE_ENABLED', 'true'); vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', '/repo'); vi.stubEnv('JWT_SECRET', 'test-secret-remote-gym');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); db.close(); });

it('unknown tokens are stored as unknown (null), never as 0; an older worker\'s 0 is unknown too; a reported count is kept', () => {
  const svc = new RemoteGymService(db, () => [TASK('c1'), TASK('c2'), TASK('c3')]);
  const run = () => (svc.claim('workstation', ['atomic@llama-router']) as { runId: string }).runId;
  const a = run(); svc.record(a, 'workstation', { ...WIN, tokens: null as never }); // new worker: atomic printed no usage
  const b = run(); svc.record(b, 'workstation', { ...WIN, tokens: 0 }); // older worker: always 0 outside TG-001
  const c = run(); svc.record(c, 'workstation', { ...WIN, tokens: 1200 });
  expect([gymResult(a).tokens, gymResult(b).tokens, gymResult(c).tokens]).toEqual([null, null, 1200]);
  expect(outcomes()).toEqual([{ tokens_used: null }, { tokens_used: null }, { tokens_used: 1200 }]);
});

it('readers treat unknown (NULL) gym tokens as unknown: fitness efficiency and the cockpit average use only reported counts', () => {
  const svc = new RemoteGymService(db, () => [TASK('c1'), TASK('c2')]);
  const run = () => (svc.claim('workstation', ['atomic@llama-router']) as { runId: string }).runId;
  svc.record(run(), 'workstation', { ...WIN, tokens: undefined });
  // only unknown so far: no efficiency and no average token count (never 1.0 / 0)
  expect(new SkillEvolutionEngine(db).measuredTraits('loop-maker:gym:atomic').efficiency).toBeNull();
  expect(operatorCockpit(db).gym.find((g) => g.species === 'atomic@llama-router')?.avg_tokens).toBeNull();
  svc.record(run(), 'workstation', { ...WIN, tokens: 2000 });
  expect(new SkillEvolutionEngine(db).measuredTraits('loop-maker:gym:atomic').efficiency).toBe(0.5); // min(1, 1000/2000), the unknown row left out
  expect(operatorCockpit(db).gym.find((g) => g.species === 'atomic@llama-router')?.avg_tokens).toBe(2000);
  expect(new SkillEvolutionEngine(db).measuredTraits('loop-maker:gym:atomic').reliability).toBe(1); // both still count as outcomes
});

it('a repeated result for a settled run writes no second outcome and answers with the existing result (409)', async () => {
  const svc = new RemoteGymService(db, () => [TASK('c1')]);
  const { runId } = svc.claim('workstation', ['atomic@llama-router']) as { runId: string };
  svc.record(runId, 'workstation', { ...WIN, tokens: 900 });
  let err: unknown;
  try { svc.record(runId, 'workstation', { ...WIN, reason: 'again', tokens: 900 }); } catch (e) { err = e; }
  expect(err).toMatchObject({ message: 'GYM_RUN_ALREADY_SETTLED', existing: { status: 'success', reason: 'tests green, source only' } });
  expect(db.prepare('SELECT COUNT(*) AS n FROM skill_outcomes').get()).toEqual({ n: 1 });
  expect(gymResult(runId).late_result).toBeUndefined(); // a duplicate of a real result is not a late result

  // over HTTP: the same 409 the worker already handles, now with the existing result in the body
  const pass = (_req: any, _res: any, next: any) => next();
  const app = express().use(rateLimit({ windowMs: 60_000, limit: 600 })).use(express.json());
  app.use('/gym-worker', createRemoteGymRoutes(db, { requireAuth: pass, requirePermission: () => pass } as never));
  const token = mintSpawnToken(resolveSpawnTokenSecret(), 'workstation', REMOTE_GYM_SCOPE, 60_000);
  const res = await request(app).post(`/gym-worker/runs/${runId}/result`).set('X-Gym-Host', 'workstation').set('X-Gym-Worker-Token', token).send(WIN).expect(409);
  expect(res.body).toMatchObject({ error: { code: 'GYM_RUN_ALREADY_SETTLED' }, gym_result: { status: 'success', reason: 'tests green, source only' } });
  expect(db.prepare('SELECT COUNT(*) AS n FROM skill_outcomes').get()).toEqual({ n: 1 });
});

it('a kill between the outcome write and the run settlement leaves neither half; the retried report then counts once', () => {
  const svc = new RemoteGymService(db, () => [TASK('c1')]);
  const { runId } = svc.claim('workstation', ['atomic@llama-router']) as { runId: string };
  const real = SkillEvolutionEngine.prototype.recordOutcome;
  const spy = vi.spyOn(SkillEvolutionEngine.prototype, 'recordOutcome').mockImplementation(function (this: SkillEvolutionEngine, ...args) {
    real.apply(this, args); // the outcome row is written ...
    throw new Error('SIMULATED_KILL'); // ... and the process dies before the run is settled
  });
  expect(() => svc.record(runId, 'workstation', { ...WIN, tokens: 700 })).toThrow('SIMULATED_KILL');
  expect(db.prepare('SELECT COUNT(*) AS n FROM skill_outcomes').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT status FROM loop_runs WHERE id = ?').get(runId)).toEqual({ status: 'running' });
  expect(gymResult(runId)).toBeNull();
  spy.mockRestore();
  svc.record(runId, 'workstation', { ...WIN, tokens: 700 });
  expect(db.prepare('SELECT COUNT(*) AS n FROM skill_outcomes').get()).toEqual({ n: 1 });
  expect(gymResult(runId)).toMatchObject({ status: 'success', tokens: 700 });
});

it('GYM_ORPHAN_SWEEP settles only stale running remote runs without a result, writes no outcome, and the task is served again', () => {
  const now = new Date('2026-10-25T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const svc = new RemoteGymService(db, () => [TASK('c1'), TASK('c2'), TASK('c3')]);
  const stale = (svc.claim('workstation', ['atomic@llama-router'], ago(3 * 3_600_000)) as { runId: string; task: { commit: string } });
  const fresh = (svc.claim('nas', ['atomic@llama-router'], ago(5 * 60_000)) as { runId: string });
  const withResult = (svc.claim('gpu-box', ['atomic@llama-router'], ago(4 * 3_600_000)) as { runId: string });
  // a row in the middle of nowhere: 'running' but already carrying a result — never touched
  db.prepare("UPDATE loop_runs SET metadata = json_set(metadata, '$.gym_result', json('{\"status\":\"failure\",\"reason\":\"tests still red\"}')) WHERE id = ?").run(withResult.runId);
  // a local (VPS) gym run and a finished remote run, both old
  db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, metadata, created_at, updated_at) VALUES ('local', 'evolution-gym', 'closed', 'running', ?, ?, ?)")
    .run(JSON.stringify({ gym: { commit: 'cL', species: 'opencode' } }), ago(5 * 3_600_000).toISOString(), ago(5 * 3_600_000).toISOString());
  expect(stale.task.commit).toBe('c1');
  expect(triedTasks(db, 'atomic@llama-router').has('c1')).toBe(true); // while it runs the task is taken

  // default off: nothing happens
  expect(sweepOrphanedGymRuns(db, now)).toEqual({ mode: 'off', candidates: [], settled: [] });
  vi.stubEnv('GYM_ORPHAN_SWEEP', 'shadow');
  expect(sweepOrphanedGymRuns(db, now)).toEqual({ mode: 'shadow', candidates: [stale.runId], settled: [] });
  expect(db.prepare('SELECT status FROM loop_runs WHERE id = ?').get(stale.runId)).toEqual({ status: 'running' });
  vi.stubEnv('GYM_ORPHAN_SWEEP', 'on');
  expect(sweepOrphanedGymRuns(db, now)).toEqual({ mode: 'on', candidates: [stale.runId], settled: [stale.runId] });
  expect(sweepOrphanedGymRuns(db, now).settled).toEqual([]); // idempotent

  expect(gymResult(stale.runId)).toEqual({ status: 'discarded', reason: 'infra: orphaned_no_result' });
  for (const id of [fresh.runId, withResult.runId, 'local']) expect(db.prepare('SELECT status FROM loop_runs WHERE id = ?').get(id)).toEqual({ status: 'running' });
  expect(gymResult(withResult.runId)).toEqual({ status: 'failure', reason: 'tests still red' });
  expect(db.prepare('SELECT COUNT(*) AS n FROM skill_outcomes').get()).toEqual({ n: 0 });
  expect(triedTasks(db, 'atomic@llama-router').has('c1')).toBe(false);
  expect(svc.claim('workstation', ['atomic@llama-router'], now)).toMatchObject({ task: { commit: 'c1' } }); // re-served

  // the lost worker reports after all: still refused (409), recorded as a late result, still no outcome
  expect(() => svc.record(stale.runId, 'workstation', { ...WIN, tokens: 500 })).toThrow('GYM_RUN_ALREADY_SETTLED');
  expect(gymResult(stale.runId)).toEqual({ status: 'discarded', reason: 'infra: orphaned_no_result', late_result: 1 });
  expect(db.prepare('SELECT COUNT(*) AS n FROM skill_outcomes').get()).toEqual({ n: 0 });
});

it('the orphan timeout follows GYM_MAKER_TIMEOUT_MS plus the margin', () => {
  vi.stubEnv('GYM_ORPHAN_SWEEP', 'on');
  const now = new Date('2026-10-25T12:00:00Z');
  const svc = new RemoteGymService(db, () => [TASK('c1')]);
  const { runId } = svc.claim('workstation', ['atomic@llama-router'], new Date(now.getTime() - 60 * 60_000)) as { runId: string }; // 60 min ago
  expect(sweepOrphanedGymRuns(db, now).candidates).toEqual([]); // default 15 min maker + 90 min margin
  vi.stubEnv('GYM_MAKER_TIMEOUT_MS', String(-89 * 60_000)); // nonsense is ignored
  expect(sweepOrphanedGymRuns(db, now).candidates).toEqual([]);
  vi.stubEnv('GYM_MAKER_TIMEOUT_MS', String(60_000)); // 1 min maker + 90 min margin: still inside
  expect(sweepOrphanedGymRuns(db, now).candidates).toEqual([]);
  expect(sweepOrphanedGymRuns(db, new Date(now.getTime() + 32 * 60_000)).settled).toEqual([runId]);
});
