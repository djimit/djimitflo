import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { RemoteGymService, REMOTE_GYM_SCOPE } from '../services/remote-gym-service';
import { infraFailing } from '../services/evolution-gym-service';
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

it('the circuit breaker only counts infra discards after the species last succeeded', () => {
  const ins = (id: string, at: string, status: string, reason: string) => db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, metadata, created_at) VALUES (?, 'evolution-gym', 'closed', 'completed', ?, ?)")
    .run(id, JSON.stringify({ gym: { commit: id, species: 'atomic@llama-router', remote_host: 'workstation' }, gym_result: { status, reason } }), at);
  const t = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  ins('a', t(150), 'discarded', 'infra: crash'); ins('b', t(140), 'success', 'tests green'); ins('c', t(120), 'discarded', 'infra: git'); ins('d', t(100), 'discarded', 'infra: git');
  const since = t(24 * 60);
  expect(infraFailing(db, 'atomic@llama-router', since)).toBe(false); // 2 after the success
  ins('e', t(80), 'discarded', 'infra: git');
  expect(infraFailing(db, 'atomic@llama-router', since)).toBe(true);
});

it('a new claim settles the host\'s own run that never reported (infra discard, task stays untried)', () => {
  const svc = new RemoteGymService(db, () => [TASK('c1')]);
  vi.stubEnv('EVOLUTION_GYM_REMOTE_MAX_PER_DAY', '100');
  const first = svc.claim('workstation', ['atomic@llama-router']) as { runId: string };
  db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, metadata, created_at) VALUES ('other-host', 'evolution-gym', 'closed', 'running', ?, datetime('now'))").run(JSON.stringify({ gym: { commit: 'x', species: 'atomic@llama-router', remote_host: 'nas' } }));
  expect(svc.claim('workstation', ['atomic@llama-router'])).toMatchObject({ species: 'atomic@llama-router', task: { commit: 'c1' } }); // same task again: untried
  expect(db.prepare("SELECT status, json_extract(metadata, '$.gym_result.reason') AS r FROM loop_runs WHERE id = ?").get(first.runId))
    .toEqual({ status: 'completed', r: 'infra: worker lost the result (no report before its next claim)' });
  expect(db.prepare("SELECT status FROM loop_runs WHERE id = 'other-host'").get()).toEqual({ status: 'running' }); // another host untouched
});

it('half-open: after a 2 h quiet cool-down one probe is let through; a new infra discard re-opens the breaker', () => {
  const ins = (id: string, minsAgo: number) => db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, metadata, created_at) VALUES (?, 'evolution-gym', 'closed', 'completed', ?, ?)")
    .run(id, JSON.stringify({ gym: { commit: id, species: 'atomic@llama-router' }, gym_result: { status: 'discarded', reason: 'infra: maker produced nothing (no change)' } }), new Date(Date.now() - minsAgo * 60_000).toISOString());
  const since = new Date(Date.now() - 86_400_000).toISOString();
  ins('p1', 600); ins('p2', 580); ins('p3', 560); // tripped 9 h ago (prod 2026-09-27)
  expect(infraFailing(db, 'atomic@llama-router', since)).toBe(false); // cool-down passed: probe allowed
  ins('p4', 5); // the probe failed on infra again
  expect(infraFailing(db, 'atomic@llama-router', since)).toBe(true);
});

it('maker routes: a host-scoped token claims its own queued job and returns a patch', async () => {
  const pass = (_req: any, _res: any, next: any) => next();
  const app = express(); app.use(express.json());
  app.use('/gym-worker', createRemoteGymRoutes(db, { requireAuth: pass, requirePermission: () => pass } as never));
  const { RemoteMakerQueue } = await import('../services/remote-maker-queue');
  const q = new RemoteMakerQueue(db);
  const id = q.enqueue('workstation', 'atomic@llama-router', 'abc', 'fix it');
  const token = mintSpawnToken(resolveSpawnTokenSecret(), 'workstation', REMOTE_GYM_SCOPE, 60_000);
  await request(app).post('/gym-worker/maker/claim').set('X-Gym-Host', 'workstation').send({ species: ['atomic@llama-router'] }).expect(401);
  const claimed = await request(app).post('/gym-worker/maker/claim').set('X-Gym-Host', 'workstation').set('X-Gym-Worker-Token', token).send({ species: ['atomic@llama-router'] }).expect(200);
  expect(claimed.body.job).toMatchObject({ id, base_commit: 'abc' });
  await request(app).post(`/gym-worker/maker/${id}/result`).set('X-Gym-Host', 'workstation').set('X-Gym-Worker-Token', token).send({ status: 'done', patch: 'diff', reason: 'ok' }).expect(200);
  expect(q.get(id)).toMatchObject({ status: 'done', patch: 'diff' });
});
