import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHmac } from 'crypto';
import Database from 'better-sqlite3';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { RemoteGymService, REMOTE_GYM_SCOPE } from '../services/remote-gym-service';
import { createRemoteGymRoutes } from '../routes/remote-gym';
import { gymSkillContentHash } from '../services/gym-skill-hash';
import { mintSpawnToken, resolveSpawnTokenSecret, spawnTokenRejection, validateSpawnToken } from '../services/spawn-token';
import { HOST_AGENT_SCOPE } from '../routes/host-agent';

const TASK = (commit: string) => ({ commit, source: 'packages/server/src/services/x.ts', tests: ['packages/server/src/__tests__/x.test.ts'], sourceLines: 5 });
let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  vi.stubEnv('EVOLUTION_GYM_REMOTE_ENABLED', 'true'); vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', '/repo'); vi.stubEnv('JWT_SECRET', 'test-secret-followups');
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); db.close(); });

it('1. reviewers see the assertion-strength shadow verdict, not the gate status (guard: already true since #730)', () => {
  const svc = Object.create(LoopService.prototype) as { checkResultsForReviewer(raw: unknown): string };
  const text = svc.checkResultsForReviewer([{ name: 'test:assertion-strength', mode: 'shadow', status: 'skipped', shadow_status: 'fail', exit_status: null }]);
  expect(text).toContain('test:assertion-strength: shadow fail');
  expect(text).not.toContain('test:assertion-strength: skipped');
});

it('2. remote gym outcomes carry skill_content_hash: same genome + kind → same hash, another genome → another', () => {
  const svc = new RemoteGymService(db, () => [TASK('c1'), TASK('c2')]);
  const a = svc.claim('workstation', ['atomic@llama-router']) as { runId: string };
  svc.record(a.runId, 'workstation', { status: 'success', reason: 'tests green, source only' });
  const row = db.prepare('SELECT skill_content_hash AS h FROM skill_outcomes').get() as { h: string | null };
  expect(row.h).toBe(gymSkillContentHash(undefined, null));
  expect(gymSkillContentHash(undefined, null)).toBe(gymSkillContentHash('repair', null));
  expect(gymSkillContentHash('repair', 'g-1')).not.toBe(gymSkillContentHash('repair', null));
  expect(gymSkillContentHash('write_test', null)).not.toBe(gymSkillContentHash('repair', null));
});

it('3. a refused gym worker token logs its specific reason; the response stays the same', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const pass = (_req: any, _res: any, next: any) => next();
  const app = express(); app.use(rateLimit({ windowMs: 60_000, limit: 600 })); app.use(express.json());
  app.use('/gym-worker', createRemoteGymRoutes(db, { requireAuth: pass, requirePermission: () => pass } as never));
  const other = mintSpawnToken(resolveSpawnTokenSecret(), 'nas', REMOTE_GYM_SCOPE, 60_000);
  const res = await request(app).post('/gym-worker/claim').set('X-Gym-Host', 'workstation').set('X-Gym-Worker-Token', other).send({}).expect(401);
  expect(res.body.error.code).toBe('GYM_WORKER_TOKEN_INVALID');
  expect(JSON.stringify(res.body)).not.toContain('wrong_subject'); // reason stays server-side
  expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('reason=wrong_subject');
  const expired = mintSpawnToken(resolveSpawnTokenSecret(), 'workstation', REMOTE_GYM_SCOPE, -1000);
  await request(app).post('/gym-worker/claim').set('X-Gym-Host', 'workstation').set('X-Gym-Worker-Token', expired).send({}).expect(401);
  expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('reason=expired');
});

it('4. a token payload with more than three fields is malformed; every minting scope still validates', () => {
  const secret = 'followups-strict-fields';
  const sign = (payload: string) => { const b64 = Buffer.from(payload, 'utf8').toString('base64url'); return `${b64}.${createHmac('sha256', secret).update(b64).digest('base64url')}`; };
  const later = Date.now() + 60_000;
  expect(spawnTokenRejection(secret, sign(`workstation|${REMOTE_GYM_SCOPE}|${later}|extra`), 'workstation', REMOTE_GYM_SCOPE)).toBe('malformed');
  expect(validateSpawnToken(secret, sign(`workstation|${REMOTE_GYM_SCOPE}|${later}|extra`), 'workstation', REMOTE_GYM_SCOPE)).toBe(false);
  for (const [subject, scope] of [['workstation', REMOTE_GYM_SCOPE], ['vps', HOST_AGENT_SCOPE], ['agent-1', 'social-runtime'], ['lease-1', 'tree-1']] as const) {
    expect(validateSpawnToken(secret, mintSpawnToken(secret, subject, scope, 60_000), subject, scope)).toBe(true);
  }
});
