import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { REMOTE_GYM_SCOPE } from '../services/remote-gym-service';
import { createRemoteGymRoutes } from '../routes/remote-gym';
import { mintSpawnToken, resolveSpawnTokenSecret } from '../services/spawn-token';

// the route builds its own RemoteGymService, which mines the deploy checkout: hand it one fixed task instead
vi.mock('../services/gym-task-miner', async (orig) => ({
  ...(await orig<typeof import('../services/gym-task-miner')>()),
  mineGymTasks: () => [{ commit: 'h1', source: 'packages/server/src/services/x.ts', tests: ['packages/server/src/__tests__/x.test.ts'], sourceLines: 5 }],
}));

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  vi.stubEnv('EVOLUTION_GYM_REMOTE_ENABLED', 'true'); vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', '/repo'); vi.stubEnv('JWT_SECRET', 'test-secret-remote-gym');
  vi.stubEnv('LOOP_DAEMON_CHECK_SCRIPTS', ''); vi.stubEnv('LOOP_DAEMON_CHECK_TIMEOUT_MS', '');
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

function app() {
  const pass = (_req: any, _res: any, next: any) => next();
  const a = express().use(rateLimit({ windowMs: 60_000, limit: 600 })).use(express.json());
  a.use('/gym-worker', createRemoteGymRoutes(db, { requireAuth: pass, requirePermission: () => pass } as never));
  return a;
}

it('GYM_PROD_GATES: over HTTP the claim response carries the gate config and the result route stores the checks', async () => {
  vi.stubEnv('GYM_PROD_GATES', 'true');
  const token = mintSpawnToken(resolveSpawnTokenSecret(), 'workstation', REMOTE_GYM_SCOPE, 60_000);
  const claim = await request(app()).post('/gym-worker/claim').set('X-Gym-Host', 'workstation').set('X-Gym-Worker-Token', token)
    .send({ species: ['atomic'], capabilities: ['canary', 'write_test', 'prod_gates'] }).expect(200);
  expect(claim.body).toMatchObject({ task: { commit: 'h1' }, prod_gates: { scripts: ['test:changed', 'lint', 'type-check'], timeout_ms: 120_000, diff_max_lines: 200 } });
  await request(app()).post(`/gym-worker/runs/${claim.body.runId}/result`).set('X-Gym-Host', 'workstation').set('X-Gym-Worker-Token', token)
    .send({ status: 'success', reason: 'tests green, source only', prod_gates: { diff_limit: 'pass', lint: 'pass' } }).expect(200);
  expect(db.prepare("SELECT json_extract(metadata, '$.gym_result.prod_gates') AS g FROM loop_runs WHERE id = ?").get(claim.body.runId)).toEqual({ g: '{"diff_limit":"pass","lint":"pass"}' });
});

it('GYM_PROD_GATES off (default): the claim response has no gate config — the worker keeps its proxy oracle', async () => {
  const token = mintSpawnToken(resolveSpawnTokenSecret(), 'workstation', REMOTE_GYM_SCOPE, 60_000);
  const claim = await request(app()).post('/gym-worker/claim').set('X-Gym-Host', 'workstation').set('X-Gym-Worker-Token', token)
    .send({ species: ['atomic'], capabilities: ['prod_gates'] }).expect(200);
  expect(claim.body.task).toMatchObject({ commit: 'h1' });
  expect(claim.body).not.toHaveProperty('prod_gates');
});
