import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import cors from 'cors';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { createTestDb } from './helpers/test-db';
import { AuthService } from '../services/auth-service';
import { AuditService } from '../services/audit-service';
import { createAuthMiddleware } from '../middleware/auth';
import { createAuthRoutes } from '../routes/auth';
import { errorHandler } from '../middleware/error-handler';

let db: ReturnType<typeof createTestDb>;
let auth: AuthService;
let audit: AuditService;
let server: Server;
let base: string;
const browser = { 'X-Djimitflo-Session': 'browser' };
const credentials = { email: 'cookie@example.test', password: 'disposable-cookie-test-password' };

beforeEach(async () => {
  vi.stubEnv('JWT_SECRET', 'disposable-cookie-session-test-secret');
  vi.stubEnv('JWT_EXPIRES_IN', '15m');
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('AUTH_COOKIE_SECURE', '');
  db = createTestDb();
  auth = new AuthService(db);
  auth.createUser(credentials.email, credentials.password, 'maker');
  audit = new AuditService(db);
  const app = express();
  app.use(cors({ origin: ['http://localhost:5173'], credentials: true }));
  app.use(express.json());
  app.use('/api/auth', createAuthRoutes(auth, createAuthMiddleware(auth), audit));
  app.use(errorHandler);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth`;
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
});

function request(path: string, body: unknown = {}, headers: Record<string, string> = browser) {
  return fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
function cookie(response: globalThis.Response): string {
  const value = response.headers.get('set-cookie');
  expect(Boolean(value?.startsWith('djimitflo_refresh='))).toBe(true);
  return value!.split(';')[0];
}
function raw(cookieHeader: string): string { return decodeURIComponent(cookieHeader.split('=')[1]); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
async function login() { const response = await request('/login', credentials); expect(response.status).toBe(200); return response; }

it('keeps legacy login and logout compatible without claiming access-token revocation', async () => {
  const response = await request('/login', credentials, {});
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toBeNull();
  const body = await response.json() as { token: string; user: unknown };
  expect(Object.keys(body).sort()).toEqual(['token', 'user']);
  expect(db.prepare('SELECT count(*) n FROM refresh_tokens').get()).toEqual({ n: 0 });
  expect((await request('/logout', {}, { authorization: `Bearer ${body.token}` })).status).toBe(200);
  expect(Boolean(auth.verifyToken(body.token))).toBe(true);
});

it('issues only a scoped HttpOnly Strict cookie and access-token body, rotates with durable hash lineage', async () => {
  const response = await login();
  expect(response.headers.get('cache-control')).toBe('no-store');
  const oldCookie = cookie(response);
  const flags = response.headers.get('set-cookie')!;
  expect(flags).toContain('HttpOnly'); expect(flags).toContain('SameSite=Strict'); expect(flags).toContain('Path=/api/auth');
  expect(flags).toContain('Max-Age=2592000'); expect(flags).not.toContain('Secure');
  const first = await response.json() as { token: string; user: { id: string }; expires_in: number };
  expect(Object.keys(first).sort()).toEqual(['expires_in', 'token', 'user']);
  expect(first.expires_in).toBe(900);
  expect(JSON.stringify(first).includes(raw(oldCookie))).toBe(false);
  // Keep one explicit HTTP method/path canary visible to contract inventory;
  // the local helper's default POST is not statically resolved by that scanner.
  const refreshed = await fetch(base + '/refresh', {
    method: 'POST', headers: { ...browser, cookie: oldCookie, 'content-type': 'application/json' }, body: '{}',
  });
  expect(refreshed.status).toBe(200);
  const replacement = cookie(refreshed);
  expect(replacement === oldCookie).toBe(false);
  const result = await refreshed.json() as { token: string; user: { id: string }; expires_in: number };
  expect(result.user.id).toBe(first.user.id);
  expect(Object.keys(result).sort()).toEqual(['expires_in', 'token', 'user']);
  const rows = db.prepare('SELECT token_hash,session_id,rotated_from,revoked FROM refresh_tokens ORDER BY rowid').all() as { token_hash: string; session_id: string; rotated_from: string | null; revoked: number }[];
  expect(rows.length).toBe(2);
  expect(rows[0].revoked).toBe(1); expect(rows[1].revoked).toBe(0);
  expect(rows[1].session_id).toBe(rows[0].session_id);
  expect(rows[1].rotated_from).toBe(hash(raw(oldCookie)));
  expect(rows[1].token_hash).toBe(hash(raw(replacement)));
  expect(JSON.stringify(rows).includes(raw(oldCookie))).toBe(false);
  const actions = db.prepare('SELECT action FROM audit_events ORDER BY rowid').all();
  expect(actions).toEqual([{ action: 'auth.login' }, { action: 'auth.refresh' }]);
});

it.each([
  ['production', '', true], ['production', 'false', false], ['test', 'true', true],
] as const)('cookie secure configuration %s / %s', async (environment, override, expected) => {
  vi.stubEnv('NODE_ENV', environment); vi.stubEnv('AUTH_COOKIE_SECURE', override);
  expect((await login()).headers.get('set-cookie')!.includes('; Secure')).toBe(expected);
});

it('rejects cookie mutation without browser header and does not authorize a hostile preflight', async () => {
  const initial = cookie(await login());
  for (const path of ['/refresh', '/logout']) {
    expect((await request(path, {}, { cookie: initial })).status).toBe(403);
  }
  expect((await request('/refresh', {}, { ...browser, cookie: initial })).status).toBe(200);
  const preflight = await fetch(base + '/refresh', {
    method: 'OPTIONS', headers: { origin: 'https://hostile.invalid', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-djimitflo-session' },
  });
  expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
});

it.each(['', 'djimitflo_refresh=%invalid', 'djimitflo_refresh=unknown', 'djimitflo_refresh=a; djimitflo_refresh=b'])('rejects absent/malformed/unknown/ambiguous refresh cookie without body fallback: %s', async cookieHeader => {
  expect((await request('/refresh', { refresh_token: 'body-is-not-accepted' }, { ...browser, cookie: cookieHeader })).status).toBe(401);
});

it('rejects same-day expired refresh cookies and clears the browser cookie', async () => {
  const initial = cookie(await login());
  db.prepare('UPDATE refresh_tokens SET expires_at=?').run(new Date(Date.now() - 1000).toISOString());
  const response = await request('/refresh', {}, { ...browser, cookie: initial });
  expect(response.status).toBe(401);
  expect(cookie(response)).toBe('djimitflo_refresh=');
});

it('logout from a rotated predecessor revokes that session, not a separate browser session, and is idempotent', async () => {
  const first = await login(); const firstCookie = cookie(first);
  const sibling = await login(); const siblingCookie = cookie(sibling);
  const rotated = await request('/refresh', {}, { ...browser, cookie: firstCookie });
  const rotatedCookie = cookie(rotated);
  const access = (await rotated.json() as { token: string }).token;
  expect((await fetch(base + '/me', { headers: { authorization: `Bearer ${access}` } })).status).toBe(200);
  const logout = await request('/logout', {}, { ...browser, cookie: firstCookie });
  expect(logout.status).toBe(200); expect(cookie(logout)).toBe('djimitflo_refresh=');
  expect(auth.verifyToken(access)).toBeNull();
  expect((await fetch(base + '/me', { headers: { authorization: `Bearer ${access}` } })).status).toBe(401);
  expect((await request('/logout', {}, { ...browser, cookie: firstCookie })).status).toBe(200);
  expect((await request('/refresh', {}, { ...browser, cookie: siblingCookie })).status).toBe(200);
  // Testing the logged-out cookie last: existing replay policy is user-wide.
  expect((await request('/refresh', {}, { ...browser, cookie: rotatedCookie })).status).toBe(401);
});

it('replayed refresh cookie invalidates its replacement access and refresh credentials', async () => {
  const firstCookie = cookie(await login());
  const rotated = await request('/refresh', {}, { ...browser, cookie: firstCookie });
  const replacement = cookie(rotated); const access = (await rotated.json() as { token: string }).token;
  expect((await request('/refresh', {}, { ...browser, cookie: firstCookie })).status).toBe(401);
  expect(auth.verifyToken(access)).toBeNull();
  expect((await request('/refresh', {}, { ...browser, cookie: replacement })).status).toBe(401);
});

it('browser logout can revoke its authenticated session if the refresh cookie was cleared', async () => {
  const response = await login();
  const access = (await response.json() as { token: string }).token;
  const headers = { ...browser, authorization: `Bearer ${access}` };
  expect((await request('/logout', {}, headers)).status).toBe(200);
  expect((await fetch(base + '/me', { headers })).status).toBe(401);
});

it('browser logout revokes both presented session credentials, never arbitrary body session IDs', async () => {
  const first = await login(); const firstCookie = cookie(first);
  const firstAccess = (await first.json() as { token: string }).token;
  const secondAccess = (await (await login()).json() as { token: string }).token;
  const untouchedAccess = (await (await login()).json() as { token: string }).token;
  const untouchedSid = auth.verifyToken(untouchedAccess)!.sid;
  const response = await request('/logout', { session_id: untouchedSid }, { ...browser, cookie: firstCookie, authorization: `Bearer ${secondAccess}` });
  expect(response.status).toBe(200);
  expect(auth.verifyToken(firstAccess)).toBeNull();
  expect(auth.verifyToken(secondAccess)).toBeNull();
  expect(Boolean(auth.verifyToken(untouchedAccess))).toBe(true);
});

it.each(['/login', '/refresh', '/logout'])('%s audit failure cannot partially commit a cookie session', async path => {
  const original = path === '/login' ? undefined : cookie(await login());
  const before = db.prepare('SELECT * FROM refresh_tokens ORDER BY rowid').all();
  const failure = vi.spyOn(audit, 'record').mockImplementation(() => { throw new Error('disposable audit failure'); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = await request(path, path === '/login' ? credentials : {}, { ...browser, ...(original ? { cookie: original } : {}) });
  expect(response.status).toBe(500);
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(db.prepare('SELECT * FROM refresh_tokens ORDER BY rowid').all()).toEqual(before);
  failure.mockRestore();
  if (original) expect((await request('/refresh', {}, { ...browser, cookie: original })).status).toBe(200);
});

it('rolls back both presented logout sessions when the second audit append fails', async () => {
  const first = await login(); const firstCookie = cookie(first);
  const firstAccess = (await first.json() as { token: string }).token;
  const secondAccess = (await (await login()).json() as { token: string }).token;
  const before = db.prepare('SELECT * FROM refresh_tokens ORDER BY rowid').all();
  const auditBefore = db.prepare('SELECT count(*) n FROM audit_events').get();
  const record = audit.record.bind(audit);
  vi.spyOn(audit, 'record').mockImplementationOnce(record).mockImplementationOnce(() => { throw new Error('disposable second audit failure'); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = await request('/logout', {}, { ...browser, cookie: firstCookie, authorization: `Bearer ${secondAccess}` });
  expect(response.status).toBe(500);
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(db.prepare('SELECT * FROM refresh_tokens ORDER BY rowid').all()).toEqual(before);
  expect(db.prepare('SELECT count(*) n FROM audit_events').get()).toEqual(auditBefore);
  expect(Boolean(auth.verifyToken(firstAccess))).toBe(true);
  expect(Boolean(auth.verifyToken(secondAccess))).toBe(true);
});

it('validates requested organization against current membership without consuming a valid cookie on invalid shape', async () => {
  const initial = cookie(await login());
  expect((await request('/refresh', { organization_id: ['default'] }, { ...browser, cookie: initial })).status).toBe(400);
  const accepted = await request('/refresh', { organization_id: 'default' }, { ...browser, cookie: initial });
  expect(accepted.status).toBe(200);
  const selected = await accepted.json() as { token: string };
  expect(auth.verifyToken(selected.token)?.organization_id).toBe('default');
  expect((await request('/refresh', { organization_id: 'unassigned' }, { ...browser, cookie: cookie(accepted) })).status).toBe(401);
  // Authorization rejection must not consume the valid server-side credential.
  expect((await request('/refresh', { organization_id: 'default' }, { ...browser, cookie: cookie(accepted) })).status).toBe(200);
});

it('refresh returns current role and rejects a subsequently disabled account', async () => {
  const firstCookie = cookie(await login());
  db.prepare("UPDATE users SET role='viewer' WHERE email=?").run(credentials.email);
  const refreshed = await request('/refresh', {}, { ...browser, cookie: firstCookie });
  expect(refreshed.status).toBe(200);
  const currentCookie = cookie(refreshed);
  const body = await refreshed.json() as { token: string; user: { role: string } };
  expect(body.user.role).toBe('viewer');
  expect(auth.verifyToken(body.token)?.role).toBe('viewer');
  db.prepare('UPDATE users SET is_active=0 WHERE email=?').run(credentials.email);
  expect((await request('/refresh', {}, { ...browser, cookie: currentCookie })).status).toBe(401);
});
