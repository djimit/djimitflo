import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { detectStallsWithHealth } from '../services/stall-watch';
import { hostTokenStalls, hostTokenWatchMode, recordHostTokenOk as ok0, recordHostTokenRejection as rej0 } from '../services/host-token-watch';
import { createRemoteGymRoutes } from '../routes/remote-gym';
import { EVOLUTION_FLAGS } from '../services/evolution-evidence';
import { REMOTE_GYM_SCOPE } from '../services/remote-gym-service';
import { mintSpawnToken, resolveSpawnTokenSecret, spawnTokenExpiresAt } from '../services/spawn-token';

/** capability chain (stall-watch): a configured environment, so these tests see only the detectors they assert on */
const C = { DJIMITFLO_SKILLS_DIR: __dirname, DJIMIT_SKILL_TRAINING_EVAL_RUNNER: __filename, HOST_TOKEN_WATCH_MODE: 'shadow' };
const ON = { HOST_TOKEN_WATCH_MODE: 'shadow' };
const recordHostTokenOk = (d: Database.Database, h: string, s: string, exp: number | null, now: number) => ok0(d, h, s, exp, now, ON);
const recordHostTokenRejection = (d: Database.Database, h: string, s: string, r: string, now: number) => rej0(d, h, s, r, now, ON);
const EXPIRY = Date.parse('2026-10-27T00:24:00Z');
const min = 60_000;
const day = 86_400_000;

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); });
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

const hostStalls = (now: number) => detectStallsWithHealth(db, now, C).stalls.filter((s) => s.subsystem.startsWith('host_token'));

it('prod 27-10 replay: an expired gym-worker token rejected for 7 h from an active host is a stall', () => {
  // the workstation claimed with its 30-day token every 10 min until 00:20Z, then every request was refused 'expired'
  for (let t = EXPIRY - 124 * min; t < EXPIRY; t += 10 * min) recordHostTokenOk(db, 'workstation', REMOTE_GYM_SCOPE, EXPIRY, t);
  expect(hostTokenStalls(db, EXPIRY - min).map((s) => s.subsystem)).toEqual([`host_token_expiry:${REMOTE_GYM_SCOPE}:workstation`]);
  for (let t = EXPIRY + min; t < EXPIRY + 7.5 * 3_600_000; t += 5 * min) recordHostTokenRejection(db, 'workstation', REMOTE_GYM_SCOPE, 'expired', t);

  const now = Date.parse('2026-10-27T07:30:00Z');
  const r = detectStallsWithHealth(db, now, C);
  expect(r.detectors.find((d) => d.name === 'host_tokens')?.status).toBe('ok');
  const stalls = hostStalls(now);
  expect(stalls).toHaveLength(1); // the rejection stall supersedes the expiry warning
  expect(stalls[0]).toMatchObject({ subsystem: `host_token:${REMOTE_GYM_SCOPE}:workstation`, since: '2026-10-27T00:25:00.000Z' });
  expect(stalls[0].detail).toContain('expired');
  expect(stalls[0].detail).toContain('2026-10-27T00:20:00.000Z'); // the last valid authentication
  expect(r.health).toBe('BREACHED');
});

it('a re-minted token clears the stall; one or two rejections are not a stall', () => {
  recordHostTokenOk(db, 'nas', REMOTE_GYM_SCOPE, EXPIRY + 20 * day, EXPIRY - day);
  recordHostTokenRejection(db, 'nas', REMOTE_GYM_SCOPE, 'bad_mac', EXPIRY);
  recordHostTokenRejection(db, 'nas', REMOTE_GYM_SCOPE, 'bad_mac', EXPIRY + min);
  expect(hostTokenStalls(db, EXPIRY + 2 * min)).toEqual([]);
  recordHostTokenRejection(db, 'nas', REMOTE_GYM_SCOPE, 'bad_mac', EXPIRY + 2 * min);
  expect(hostTokenStalls(db, EXPIRY + 3 * min).map((s) => s.subsystem)).toEqual([`host_token:${REMOTE_GYM_SCOPE}:nas`]);
  recordHostTokenOk(db, 'nas', REMOTE_GYM_SCOPE, EXPIRY + 50 * day, EXPIRY + 4 * min);
  expect(hostTokenStalls(db, EXPIRY + 5 * min)).toEqual([]);
  // a later single rejection starts a new streak at 1
  recordHostTokenRejection(db, 'nas', REMOTE_GYM_SCOPE, 'bad_mac', EXPIRY + 6 * min);
  expect(hostTokenStalls(db, EXPIRY + 7 * min)).toEqual([]);
});

it('only hosts with a valid authentication in the last 7 days alarm; an unknown caller is not even recorded', () => {
  for (let i = 0; i < 5; i++) recordHostTokenRejection(db, 'stranger', REMOTE_GYM_SCOPE, 'bad_mac', EXPIRY + i * min);
  expect(db.prepare('SELECT COUNT(*) AS n FROM host_token_auth').get()).toEqual({ n: 0 });
  recordHostTokenOk(db, 'retired', REMOTE_GYM_SCOPE, EXPIRY + 3 * day, EXPIRY - 8 * day);
  for (let i = 0; i < 5; i++) recordHostTokenRejection(db, 'retired', REMOTE_GYM_SCOPE, 'expired', EXPIRY + i * min);
  expect(hostTokenStalls(db, EXPIRY + 10 * min)).toEqual([]);
});

it('expiry warning: an active host whose token expires within 7 days; never the token in the table', () => {
  recordHostTokenOk(db, 'workstation', REMOTE_GYM_SCOPE, EXPIRY, EXPIRY - 8 * day);
  expect(hostTokenStalls(db, EXPIRY - 8 * day + min)).toEqual([]);
  const s = hostTokenStalls(db, EXPIRY - 6 * day);
  expect(s).toEqual([{ subsystem: `host_token_expiry:${REMOTE_GYM_SCOPE}:workstation`, since: null, detail: expect.stringContaining('2026-10-27T00:24:00.000Z') }]);
  const cols = (db.prepare('PRAGMA table_info(host_token_auth)').all() as Array<{ name: string }>).map((c) => c.name);
  expect(cols.some((c) => /token$|secret|sig/.test(c))).toBe(false);
});

it('spawnTokenExpiresAt reads the expiry from the payload; garbage is null', () => {
  const t = mintSpawnToken('s', 'h', REMOTE_GYM_SCOPE, 60_000);
  expect(Math.abs((spawnTokenExpiresAt(t) ?? 0) - (Date.now() + 60_000))).toBeLessThan(5_000);
  expect(spawnTokenExpiresAt('garbage')).toBeNull();
});

it('the gym-worker route records a valid claim and each rejection (host, scope, reason; no token)', async () => {
  vi.stubEnv('JWT_SECRET', 'host-token-watch-secret'); vi.stubEnv('EVOLUTION_GYM_REMOTE_ENABLED', 'false'); vi.stubEnv('HOST_TOKEN_WATCH_MODE', 'shadow');
  const pass = (_r: unknown, _s: unknown, n: () => void) => n();
  const app = express(); app.use(express.json());
  app.use('/gym-worker', createRemoteGymRoutes(db, { requireAuth: pass, requirePermission: () => pass } as never));
  const good = mintSpawnToken(resolveSpawnTokenSecret(), 'ws-route', REMOTE_GYM_SCOPE, 30 * day);
  await request(app).get('/gym-worker/kb/pending').set('X-Gym-Host', 'ws-route').set('X-Gym-Worker-Token', good);
  const expired = mintSpawnToken(resolveSpawnTokenSecret(), 'ws-route', REMOTE_GYM_SCOPE, -min);
  for (let i = 0; i < 3; i++) await request(app).get('/gym-worker/kb/pending').set('X-Gym-Host', 'ws-route').set('X-Gym-Worker-Token', expired).expect(401);
  const row = db.prepare('SELECT * FROM host_token_auth WHERE host = ?').get('ws-route') as Record<string, unknown>;
  expect(row).toMatchObject({ scope: REMOTE_GYM_SCOPE, rejected_count: 3, last_reason: 'expired' });
  expect(JSON.stringify(row)).not.toContain(expired.split('.')[1]);
  expect(hostTokenStalls(db, Date.now() + 1_000).map((s) => s.subsystem)).toEqual([`host_token:${REMOTE_GYM_SCOPE}:ws-route`]);
});

it('a streak whose first rejection shares the millisecond of the last success is still a streak; a success ends it', () => {
  const T = EXPIRY;
  recordHostTokenOk(db, 'same-ms', REMOTE_GYM_SCOPE, T + 30 * day, T);
  for (let i = 0; i < 3; i++) recordHostTokenRejection(db, 'same-ms', REMOTE_GYM_SCOPE, 'expired', T);
  expect(hostTokenStalls(db, T).map((s) => s.subsystem)).toEqual([`host_token:${REMOTE_GYM_SCOPE}:same-ms`]);
  // recovery in that same millisecond: the success resets the streak explicitly
  recordHostTokenOk(db, 'same-ms', REMOTE_GYM_SCOPE, T + 30 * day, T);
  expect(hostTokenStalls(db, T)).toEqual([]);
  expect(db.prepare('SELECT rejected_count, first_rejected_at FROM host_token_auth WHERE host = ?').get('same-ms')).toEqual({ rejected_count: 0, first_rejected_at: null });
  recordHostTokenRejection(db, 'same-ms', REMOTE_GYM_SCOPE, 'expired', T);
  recordHostTokenRejection(db, 'same-ms', REMOTE_GYM_SCOPE, 'expired', T);
  expect(hostTokenStalls(db, T)).toEqual([]);
});

it('HOST_TOKEN_WATCH_MODE: off (default) records nothing and raises nothing; shadow records and reports', async () => {
  expect(hostTokenWatchMode({})).toBe('off');
  expect(hostTokenWatchMode({ HOST_TOKEN_WATCH_MODE: 'shadow' })).toBe('shadow');
  expect(hostTokenWatchMode({ HOST_TOKEN_WATCH_MODE: 'on' })).toBe('off');
  expect(EVOLUTION_FLAGS).toContainEqual({ name: 'HOST_TOKEN_WATCH_MODE', acting: false });
  ok0(db, 'quiet', REMOTE_GYM_SCOPE, EXPIRY, EXPIRY - day, {});
  for (let i = 0; i < 5; i++) rej0(db, 'quiet', REMOTE_GYM_SCOPE, 'expired', EXPIRY + i * min, {});
  expect(db.prepare('SELECT COUNT(*) AS n FROM host_token_auth').get()).toEqual({ n: 0 });
  // a row recorded while on is not reported once the flag is off
  recordHostTokenOk(db, 'loud', REMOTE_GYM_SCOPE, EXPIRY, EXPIRY - day);
  for (let i = 0; i < 3; i++) recordHostTokenRejection(db, 'loud', REMOTE_GYM_SCOPE, 'expired', EXPIRY + i * min);
  const off = detectStallsWithHealth(db, EXPIRY + 5 * min, { ...C, HOST_TOKEN_WATCH_MODE: '' });
  expect(off.detectors.find((d) => d.name === 'host_tokens')?.status).toBe('not_applicable');
  expect(off.stalls.filter((s) => s.subsystem.startsWith('host_token'))).toEqual([]);
  expect(hostStalls(EXPIRY + 5 * min).map((s) => s.subsystem)).toEqual([`host_token:${REMOTE_GYM_SCOPE}:loud`]);
  // the route records nothing with the flag off
  vi.stubEnv('JWT_SECRET', 'host-token-watch-secret'); vi.stubEnv('HOST_TOKEN_WATCH_MODE', '');
  const pass = (_r: unknown, _s: unknown, n: () => void) => n();
  const app = express(); app.use(express.json());
  app.use('/gym-worker', createRemoteGymRoutes(db, { requireAuth: pass, requirePermission: () => pass } as never));
  await request(app).get('/gym-worker/kb/pending').set('X-Gym-Host', 'ws-off').set('X-Gym-Worker-Token', mintSpawnToken(resolveSpawnTokenSecret(), 'ws-off', REMOTE_GYM_SCOPE, day));
  expect(db.prepare('SELECT COUNT(*) AS n FROM host_token_auth WHERE host = ?').get('ws-off')).toEqual({ n: 0 });
});
