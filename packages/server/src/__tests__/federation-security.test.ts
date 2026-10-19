import express from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UserRole } from '@djimitflo/shared';
import { createTestDb } from './helpers/test-db';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { createFederationRoutes, peerUrlRejection } from '../routes/federation';

// P0-1: federation register/work/inbox are admin-only, peer token env names are fenced, peer URLs are https or allow-listed.
const db = createTestDb();
const servers: Server[] = [];
const savedEnv = { ...process.env };
let base = '';
let peerBase = '';
const tokens: Record<string, string> = {};
const peerSeen: Array<{ path: string; authorization?: string }> = [];

const listen = (app: express.Express) => new Promise<Server>((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });

beforeAll(async () => {
  process.env.JWT_SECRET = 'federation-security-test-secret-'.repeat(3);
  process.env.GITHUB_TOKEN = 'ghp_must_never_leave';
  process.env.FEDERATION_PEER_TOKEN_ALPHA = 'peer-alpha-token';
  delete process.env.FEDERATION_TOKEN;
  delete process.env.OUTBOUND_DENY_HOSTS;
  const authService = new AuthService(db);
  for (const role of [UserRole.ADMIN, UserRole.MAKER, UserRole.VIEWER]) {
    tokens[role] = authService.generateToken(authService.createUser(`${role}@fed.test`, 'Federation-test-password-123!', role));
  }
  const peer = express();
  peer.use(express.json());
  peer.use((req, _res, next) => { peerSeen.push({ path: req.path, authorization: req.headers.authorization }); next(); });
  peer.get('/api/federation/capacity', (_req, res) => res.json({ available: true }));
  peer.post('/api/federation/inbox/work', (_req, res) => res.status(202).json({ accepted: true }));
  const peerServer = await listen(peer);
  servers.push(peerServer);
  peerBase = `http://127.0.0.1:${(peerServer.address() as AddressInfo).port}`;

  const auth = createAuthMiddleware(authService);
  const app = express();
  app.use(express.json());
  app.use(rateLimit({ windowMs: 60_000, limit: 600 }));
  app.use('/federation', auth.requireAuth, createFederationRoutes(db, auth));
  const local = await listen(app);
  servers.push(local);
  base = `http://127.0.0.1:${(local.address() as AddressInfo).port}/federation`;
});

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  db.close();
  process.env = savedEnv;
});

const call = (path: string, role: string, body?: unknown) => fetch(`${base}${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[role]}` },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe('P0-1 federation boundaries', () => {
  it('refuses register, work and inbox/work to non-admin roles but keeps reads open to read:evidence', async () => {
    for (const role of [UserRole.VIEWER, UserRole.MAKER]) {
      expect((await call('/register', role, { url: 'https://peer.fixture.test' })).status).toBe(403);
      expect((await call('/work', role, { goal_objective: 'x' })).status).toBe(403);
      expect((await call('/inbox/work', role, { goal_objective: 'x' })).status).toBe(403);
      expect((await call('/peers', role)).status).toBe(200);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM federation_peers').get()).toEqual({ n: 0 });
  });

  it('rejects auth_token_env that names an arbitrary server secret', async () => {
    for (const name of ['JWT_SECRET', 'GITHUB_TOKEN', 'FEDERATION_PEER_TOKEN_', 'federation_peer_token_x']) {
      const res = await call('/register', UserRole.ADMIN, { url: 'https://peer.fixture.test', metadata: { auth_token_env: name } });
      expect(res.status).toBe(400);
    }
    expect((await call('/register', UserRole.ADMIN, { url: 'https://peer.fixture.test', metadata: { auth_token_env: 'FEDERATION_PEER_TOKEN_ALPHA' } })).status).toBe(201);
  });

  it('rejects plain-http peers unless the host is in FEDERATION_ALLOWED_HOSTS, and honours OUTBOUND_DENY_HOSTS', async () => {
    expect((await call('/register', UserRole.ADMIN, { url: 'http://evil.example' })).status).toBe(400);
    expect((await call('/register', UserRole.ADMIN, { url: 'file:///etc/passwd' })).status).toBe(400);
    process.env.FEDERATION_ALLOWED_HOSTS = 'evil.example';
    expect((await call('/register', UserRole.ADMIN, { url: 'http://evil.example' })).status).toBe(201);
    delete process.env.FEDERATION_ALLOWED_HOSTS;
    expect(peerUrlRejection('https://blocked.example', { OUTBOUND_DENY_HOSTS: 'blocked.example' })).toMatch(/OUTBOUND_DENY_HOSTS/);
  });

  it('never forwards a non-peer secret from a pre-existing row, and re-validates its URL at use', async () => {
    db.prepare('DELETE FROM federation_peers').run();
    process.env.FEDERATION_ALLOWED_HOSTS = '127.0.0.1';
    db.prepare("INSERT INTO federation_peers (id,url,trust_level,metadata) VALUES ('legacy',?,'high',?)").run(peerBase, JSON.stringify({ auth_token_env: 'GITHUB_TOKEN' }));
    peerSeen.length = 0;
    const res = await call('/work', UserRole.ADMIN, { goal_objective: 'bounded work' });
    expect(res.status).toBe(200);
    expect(peerSeen.length).toBeGreaterThan(0);
    for (const seen of peerSeen) expect(seen.authorization).toBeUndefined();

    // happy path: an allowed peer token env is forwarded
    db.prepare("UPDATE federation_peers SET metadata=? WHERE id='legacy'").run(JSON.stringify({ auth_token_env: 'FEDERATION_PEER_TOKEN_ALPHA' }));
    peerSeen.length = 0;
    expect((await call('/work', UserRole.ADMIN, { goal_objective: 'bounded work' })).status).toBe(200);
    expect(peerSeen.every((s) => s.authorization === 'Bearer peer-alpha-token')).toBe(true);

    // the same row is skipped once its http host leaves the allow-list
    delete process.env.FEDERATION_ALLOWED_HOSTS;
    peerSeen.length = 0;
    const refused = await call('/work', UserRole.ADMIN, { goal_objective: 'bounded work' });
    expect(refused.status).toBe(503);
    expect((await refused.json()).attempts).toMatchObject([{ peer_id: 'legacy', status: 'url_rejected' }]);
    expect(peerSeen).toHaveLength(0);
  });
});
