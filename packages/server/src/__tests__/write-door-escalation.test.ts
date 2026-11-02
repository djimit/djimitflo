import express from 'express';
import Database from 'better-sqlite3';
import request from 'supertest';
import { rateLimit } from 'express-rate-limit';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { errorHandler } from '../middleware/error-handler';
import { createSelfImprovementRoutes } from '../routes/self-improvement';
import { createSegmlFederationRoutes } from '../routes/segml-federation';

/**
 * AUTHZ-F6: two write doors where a principal reached authority it does not hold.
 * - PUT /self-improve/telegram-identities/:id (manage:config): the mapped Telegram account acts as the mapped user
 *   (telegram-api-service mints that user's JWT), so PLATFORM_ADMIN could map its own Telegram id to an ADMIN user and
 *   approve executions (approve:task) through the bot.
 * - POST /segml/federation/receive wrote fleet-wide peer patterns with read:evidence (any VIEWER).
 */
const db = new Database(':memory:');
const tokens = new Map<UserRole, string>(); const ids = new Map<UserRole, string>();
const originalSecret = process.env.JWT_SECRET;
let app: express.Express;

beforeAll(() => {
  process.env.JWT_SECRET = 'write-door-test-secret-'.repeat(3);
  db.exec(schema); runMigrations(db);
  db.exec(`CREATE TABLE IF NOT EXISTS federation_peers (id TEXT PRIMARY KEY, url TEXT NOT NULL, trust_level TEXT NOT NULL DEFAULT 'medium',
    registered_at TEXT NOT NULL DEFAULT (datetime('now')), last_seen TEXT NOT NULL DEFAULT (datetime('now')), metadata TEXT NOT NULL DEFAULT '{}')`);
  db.prepare("INSERT OR IGNORE INTO federation_peers (id, url) VALUES ('peer-1', 'https://peer-1.example')").run();
  const authService = new AuthService(db);
  for (const role of [UserRole.ADMIN, UserRole.PLATFORM_ADMIN, UserRole.VIEWER]) {
    const user = authService.createUser(`${role}@door.test`, 'Door-test-only-password-123!', role);
    tokens.set(role, authService.generateToken(user)); ids.set(role, user.id);
  }
  const auth = createAuthMiddleware(authService);
  app = express();
  app.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false }));
  app.use(express.json());
  app.use('/self-improve', auth.requireAuth, createSelfImprovementRoutes(db, auth));
  app.use('/segml/federation', auth.requireAuth, createSegmlFederationRoutes(db, auth));
  app.use(errorHandler);
});
afterAll(() => {
  db.close();
  if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret;
});

const mapTo = (role: UserRole, telegramId: string, userId: string) => request(app).put(`/self-improve/telegram-identities/${telegramId}`)
  .set('authorization', `Bearer ${tokens.get(role)}`).send({ user_id: userId });
const mapped = (telegramId: string) => db.prepare('SELECT user_id FROM telegram_identities WHERE telegram_user_id = ?').get(telegramId);

it('PLATFORM_ADMIN cannot map a Telegram id to a user holding permissions it lacks (approve:task)', async () => {
  const res = await mapTo(UserRole.PLATFORM_ADMIN, '7001', ids.get(UserRole.ADMIN)!);
  expect(res.status).toBe(403);
  expect(res.body.error.code).toBe('TELEGRAM_MAPPING_ESCALATION');
  expect(mapped('7001')).toBeUndefined();
});

it('mapping within the caller\'s own authority keeps working', async () => {
  expect((await mapTo(UserRole.PLATFORM_ADMIN, '7002', ids.get(UserRole.VIEWER)!)).status).toBe(204);
  expect(mapped('7002')).toEqual({ user_id: ids.get(UserRole.VIEWER) });
  expect((await mapTo(UserRole.ADMIN, '7003', ids.get(UserRole.ADMIN)!)).status).toBe(204);
});

it('a VIEWER cannot write federated peer patterns', async () => {
  const body = { peerId: 'peer-1', patterns: [{ category: 'injection', avgScore: 2, agentCount: 3, trendDirection: 'stable', confidence: 0.7 }] };
  const viewer = await request(app).post('/segml/federation/receive').set('authorization', `Bearer ${tokens.get(UserRole.VIEWER)}`).send(body);
  expect(viewer.status).toBe(403);
  const admin = await request(app).post('/segml/federation/receive').set('authorization', `Bearer ${tokens.get(UserRole.ADMIN)}`).send(body);
  expect(admin.status).not.toBe(403);
});
