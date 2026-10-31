import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestDb } from './helpers/test-db';
import { AuthService } from '../services/auth-service';
import { AuditService } from '../services/audit-service';
import { createAuthMiddleware } from '../middleware/auth';
import { createAuthRoutes } from '../routes/auth';
import { errorHandler } from '../middleware/error-handler';

/**
 * D-security 30-10 §1a / candidate 7: 0 of 980 `auth.login` audit rows had an IP or user agent (routes/auth.ts passed
 * neither), so attributing the 288 logins/day needed container logs plus timer correlation. Failed logins left no row.
 */
let db: ReturnType<typeof createTestDb>;
let server: Server;
let base: string;
const credentials = { email: 'audit-client@example.test', password: 'disposable-audit-client-password' };

beforeEach(async () => {
  vi.stubEnv('JWT_SECRET', 'disposable-audit-client-test-secret');
  vi.stubEnv('NODE_ENV', 'test');
  db = createTestDb();
  const auth = new AuthService(db);
  auth.createUser(credentials.email, credentials.password, 'maker');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', createAuthRoutes(auth, createAuthMiddleware(auth), new AuditService(db)));
  app.use(errorHandler);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth`;
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.close(); vi.unstubAllEnvs();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const rows = () => db.prepare('SELECT event_type, action, outcome, user_id, ip_address, user_agent FROM audit_events ORDER BY chain_sequence')
  .all() as Array<{ event_type: string; action: string; outcome: string; user_id: string | null; ip_address: string | null; user_agent: string | null }>;

describe('auth audit rows carry the client IP and user agent', () => {
  it('a token login records ip_address and the user agent', async () => {
    expect((await post('/login', credentials, { 'user-agent': 'rotate-flo-token/1.0' })).status).toBe(200);
    const [row] = rows();
    expect(row).toMatchObject({ action: 'auth.login', user_agent: 'rotate-flo-token/1.0' });
    expect(row.ip_address).toMatch(/127\.0\.0\.1/);
  });

  it('a browser login does too, and the user agent is cut at 200 characters', async () => {
    const ua = 'Mozilla/5.0 '.padEnd(400, 'x');
    expect((await post('/login', credentials, { 'X-Djimitflo-Session': 'browser', 'user-agent': ua })).status).toBe(200);
    const [row] = rows();
    expect(row.action).toBe('auth.login');
    expect(row.ip_address).toMatch(/127\.0\.0\.1/);
    expect(row.user_agent).toBe(ua.slice(0, 200));
  });

  it('a failed login leaves a failure row with the IP and user agent, never the password', async () => {
    expect((await post('/login', { ...credentials, password: 'wrong-password' }, { 'user-agent': 'scanner/0.1' })).status).toBe(401);
    expect((await post('/login', credentials, { 'user-agent': 'rotate-flo-token/1.0' })).status).toBe(200); // resets the limiter
    const [failed] = rows();
    expect(failed).toMatchObject({ event_type: 'auth.login_failed', action: 'auth.login_failed', outcome: 'failure', user_agent: 'scanner/0.1' });
    expect(failed.ip_address).toMatch(/127\.0\.0\.1/);
    expect(JSON.stringify(db.prepare('SELECT * FROM audit_events').all())).not.toContain('wrong-password');
  });
});
