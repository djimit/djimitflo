import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { REMOTE_GYM_SCOPE } from '../services/remote-gym-service';
import { createRemoteGymRoutes } from '../routes/remote-gym';
import { mintSpawnToken, resolveSpawnTokenSecret } from '../services/spawn-token';

// re-20261105 A M8: the workstation polled committee/claim 1,159 times in 7 d for a lane that is off (COMMITTEE_SWARM_ENABLED
// unset); every poll authenticated, wrote host_token_auth and answered {job:null}. Off: 204 without a DB touch; the host's
// gym-worker reads an empty body as "no job" (`res.json().catch(() => ({}))`) and goes on to the gym claim.
let db: Database.Database;
const pass = (_req: unknown, _res: unknown, next: () => void) => next();
const app = () => express().use(express.json()).use('/gym-worker', createRemoteGymRoutes(db, { requireAuth: pass, requirePermission: () => pass } as never));
beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  vi.stubEnv('JWT_SECRET', 'test-secret-committee'); vi.stubEnv('HOST_TOKEN_WATCH_MODE', 'shadow');
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

it('committee/claim answers 204 with no body and no DB work while COMMITTEE_SWARM_ENABLED is not true', async () => {
  const token = mintSpawnToken(resolveSpawnTokenSecret(), 'workstation', REMOTE_GYM_SCOPE, 60_000);
  const a = app(); const prepare = vi.spyOn(db, 'prepare');
  const res = await request(a).post('/gym-worker/committee/claim').set('X-Gym-Host', 'workstation').set('X-Gym-Worker-Token', token).send({}).expect(204);
  expect(res.text).toBe('');
  expect(prepare).not.toHaveBeenCalled();
  // still authenticated: a bad token is refused, also without DB work
  await request(a).post('/gym-worker/committee/claim').set('X-Gym-Host', 'workstation').set('X-Gym-Worker-Token', 'nope').send({}).expect(401);
  await request(a).post('/gym-worker/committee/claim').send({}).expect(401);
  expect(prepare).not.toHaveBeenCalled();
});

it('committee/claim still hands out a job (200 {job}) when the lane is on', async () => {
  vi.stubEnv('COMMITTEE_SWARM_ENABLED', 'true');
  const token = mintSpawnToken(resolveSpawnTokenSecret(), 'workstation', REMOTE_GYM_SCOPE, 60_000);
  const res = await request(app()).post('/gym-worker/committee/claim').set('X-Gym-Host', 'workstation').set('X-Gym-Worker-Token', token).send({}).expect(200);
  expect(res.body).toEqual({ job: null }); // nothing queued
  expect(db.prepare("SELECT COUNT(*) AS n FROM host_token_auth WHERE scope = ?").get(REMOTE_GYM_SCOPE)).toEqual({ n: 1 });
});
