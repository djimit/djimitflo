import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { RemoteGymService, REMOTE_GYM_SCOPE } from '../services/remote-gym-service';
import { createRemoteGymRoutes } from '../routes/remote-gym';
import { mintSpawnToken, resolveSpawnTokenSecret } from '../services/spawn-token';

const TASK = (commit: string) => ({ commit, source: 'packages/server/src/services/x.ts', tests: ['packages/server/src/__tests__/x.test.ts'], sourceLines: 5 });
let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  vi.stubEnv('EVOLUTION_GYM_REMOTE_ENABLED', 'true'); vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', '/repo'); vi.stubEnv('JWT_SECRET', 'test-secret-remote-gym');
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

it('claim hands out an untried task per species and never repeats it; record scores it with remote evidence', () => {
  const svc = new RemoteGymService(db, () => [TASK('c1'), TASK('c2')]);
  const first = svc.claim('workstation', ['atomic@llama-router']);
  expect(first).toMatchObject({ species: 'atomic@llama-router', task: { commit: 'c1' } });
  const runId = (first as { runId: string }).runId;
  svc.record(runId, 'workstation', { status: 'success', reason: 'tests green, source only', tokens: 1200, durationMs: 40_000 });
  expect(db.prepare("SELECT skill_id, success, model, tokens_used FROM skill_outcomes").get()).toEqual({ skill_id: 'loop-maker:gym:atomic', success: 1, model: 'llama-router', tokens_used: 1200 });
  expect(db.prepare("SELECT evidence_refs_json AS e FROM skill_outcomes").get()).toMatchObject({ e: expect.stringContaining('remote:workstation') });
  expect(svc.claim('workstation', ['atomic@llama-router'])).toMatchObject({ task: { commit: 'c2' } });
  expect(() => svc.record(runId, 'workstation', { status: 'success', reason: 'again' })).toThrow('GYM_RUN_ALREADY_SETTLED');
});

it('a result from another host is refused; a discard records no outcome; the daily cap holds', () => {
  const svc = new RemoteGymService(db, () => [TASK('c1'), TASK('c2'), TASK('c3')]);
  const { runId } = svc.claim('workstation', ['atomic']) as { runId: string };
  expect(() => svc.record(runId, 'nas', { status: 'success', reason: 'x' })).toThrow('GYM_RUN_NOT_FOUND');
  svc.record(runId, 'workstation', { status: 'discarded', reason: 'infra: npm ci failed' });
  expect(db.prepare('SELECT COUNT(*) n FROM skill_outcomes').get()).toEqual({ n: 0 });
  vi.stubEnv('EVOLUTION_GYM_REMOTE_MAX_PER_DAY', '1');
  expect(svc.claim('workstation', ['atomic'])).toEqual({ skipped: 'daily cap reached' });
  vi.stubEnv('EVOLUTION_GYM_REMOTE_ENABLED', 'false');
  expect(svc.claim('workstation', ['atomic'])).toEqual({ skipped: 'disabled' });
});

it('the worker routes require a host-scoped token', async () => {
  const pass = (_req: any, _res: any, next: any) => next();
  const app = express(); app.use(express.json());
  app.use('/gym-worker', createRemoteGymRoutes(db, { requireAuth: pass, requirePermission: () => pass } as never));
  await request(app).post('/gym-worker/claim').set('X-Gym-Host', 'workstation').send({ species: ['atomic'] }).expect(401);
  const other = mintSpawnToken(resolveSpawnTokenSecret(), 'nas', REMOTE_GYM_SCOPE, 60_000);
  await request(app).post('/gym-worker/claim').set('X-Gym-Host', 'workstation').set('X-Gym-Worker-Token', other).send({ species: ['atomic'] }).expect(401);
  const minted = await request(app).post('/gym-worker/tokens').send({ host: 'workstation', ttl_days: 7 }).expect(201);
  vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', '');
  const res = await request(app).post('/gym-worker/claim').set('X-Gym-Host', 'workstation').set('X-Gym-Worker-Token', minted.body.token).send({ species: ['atomic'] }).expect(200);
  expect(res.body).toEqual({ skipped: 'no repository path' }); // auth passed, the service answered
});

it('remote claim skips an infra-failing species and says so when none is healthy', () => {
  const svc = new RemoteGymService(db, () => [TASK('c1')]);
  const now = new Date().toISOString();
  for (let i = 0; i < 3; i++) db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, metadata, created_at) VALUES (?, 'evolution-gym', 'closed', 'completed', ?, ?)")
    .run(`r-infra-${i}`, JSON.stringify({ gym: { commit: `x${i}`, species: 'atomic@broken', remote_host: 'workstation' }, gym_result: { status: 'discarded', reason: 'infra: npm ci failed' } }), now);
  vi.stubEnv('EVOLUTION_GYM_REMOTE_MAX_PER_DAY', '100');
  expect(svc.claim('workstation', ['atomic@broken'])).toEqual({ skipped: 'every species is infra-failing' });
  expect(svc.claim('workstation', ['atomic@broken', 'atomic@llama-router'])).toMatchObject({ species: 'atomic@llama-router' });
});
