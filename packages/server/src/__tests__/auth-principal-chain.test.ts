import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { WebSocketEventType, WS_CLOSE_CODES } from '@djimitflo/shared';
import { createTestDb } from './helpers/test-db';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { WebSocketService } from '../services/websocket-service';
import { createAuthRoutes } from '../routes/auth';
import { AuditService } from '../services/audit-service';
import { errorHandler } from '../middleware/error-handler';
import { createOrganizationRoutes } from '../routes/organizations';

describe('current account authority across HTTP and live sockets', () => {
  let db: ReturnType<typeof createTestDb>;
  let server: Server;
  let wss: WebSocketServer;
  let wsService: WebSocketService;
  let token: string;
  let service: AuthService;
  let base: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    db = createTestDb();
    db.exec("CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO organizations VALUES ('default','Default'), ('assigned-org','Assigned'), ('other-org','Other')");
    db.prepare("INSERT INTO users (id,email,password_hash,role) VALUES ('operator','old@example.test','unused','admin')").run();
    service = new AuthService(db);
    token = service.generateToken(service.findUserById('operator')!);
    const auth = createAuthMiddleware(service);
    const app = express();
    app.use(express.json());
    app.use('/auth', createAuthRoutes(service, auth, new AuditService(db)));
    app.use('/organizations', createOrganizationRoutes(db, auth.requireAuth, service, new AuditService(db)));
    for (const [path, middleware] of [
      ['/required', auth.requireAuth], ['/optional', auth.optionalAuth], ['/spawn', auth.requireAuthOrSpawnToken],
    ] as const) {
      app.get(path, middleware, auth.requirePermission('manage:config'), (_req, res) => res.json({ privileged: true }));
      app.get(`${path}/identity`, middleware, (req, res) => res.json(req.user));
    }
    app.use(errorHandler);
    server = createServer(app);
    wss = new WebSocketServer({ server });
    wsService = new WebSocketService(wss, service, db);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
  });

  it.each(['/required', '/optional', '/spawn'])('%s uses current role and identity, not stale signed claims', async path => {
    const headers = { authorization: `Bearer ${token}` };
    expect((await fetch(base + path, { headers })).status).toBe(200);
    db.prepare("UPDATE users SET role='viewer',email='current@example.test',organization_id='current-org' WHERE id='operator'").run();
    expect((await fetch(base + path, { headers })).status).toBe(403);
    expect(await (await fetch(base + path + '/identity', { headers })).json()).toMatchObject({
      sub: 'operator', role: 'viewer', email: 'current@example.test', organization_id: 'default',
    });
    db.prepare("UPDATE users SET is_active=0 WHERE id='operator'").run();
    expect((await fetch(base + path, { headers })).status).toBe(401);
  });

  it('retains an explicitly selected default organization and rejects stale assigned membership', async () => {
    db.prepare("UPDATE users SET organization_id='assigned-org' WHERE id='operator'").run();
    const assignedToken = service.generateToken(service.findUserById('operator')!);
    const switched = await fetch(base + '/organizations/switch', {
      method: 'POST', headers: { authorization: `Bearer ${assignedToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ organization_id: 'default' }),
    });
    expect(switched.status).toBe(200);
    const replacement = await switched.json() as { token: string };
    const identity = await fetch(base + '/required/identity', { headers: { authorization: `Bearer ${replacement.token}` } });
    expect(await identity.json()).toMatchObject({ organization_id: 'default' });
    const allowed = await fetch(base + '/organizations', { headers: { authorization: `Bearer ${replacement.token}` } });
    expect((await allowed.json() as { id: string }[]).map(org => org.id).sort()).toEqual(['assigned-org', 'default']);
    const returned = await fetch(base + '/organizations/switch', {
      method: 'POST', headers: { authorization: `Bearer ${replacement.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ organization_id: 'assigned-org' }),
    });
    expect(returned.status).toBe(200);
    expect(service.verifyToken((await returned.json() as { token: string }).token)?.organization_id).toBe('assigned-org');
    const switches = db.prepare("SELECT metadata FROM audit_events WHERE action='organization.switch' ORDER BY rowid").all() as { metadata: string }[];
    expect(switches.map(row => JSON.parse(row.metadata))).toEqual([
      { from: 'assigned-org', to: 'default' }, { from: 'default', to: 'assigned-org' },
    ]);
    db.prepare("UPDATE users SET organization_id='new-org' WHERE id='operator'").run();
    for (const path of ['/required', '/optional', '/spawn']) {
      expect((await fetch(base + path, { headers: { authorization: `Bearer ${assignedToken}` } })).status).toBe(401);
    }
  });

  it.each([
    { email: {}, password: 'unused' }, { email: ['old@example.test'], password: 'unused' },
    { email: 1, password: 'unused' }, { email: '   ', password: 'unused' },
    { email: 'old@example.test', password: {} }, { email: 'old@example.test', password: ['unused'] },
    { email: 'old@example.test', password: 1 }, undefined,
  ])('rejects malformed login input before credential operations: %j', async body => {
    const response = await fetch(base + '/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  async function connect() {
    const socket = new WebSocket(base.replace('http:', 'ws:'), `bearer.${token}`);
    sockets.push(socket);
    const received: any[] = [];
    socket.on('message', data => received.push(JSON.parse(String(data))));
    await once(socket, 'open');
    const pong = once(socket, 'pong'); socket.ping(); await pong;
    received.length = 0;
    return { socket, received };
  }

  it('new sockets use current role rather than an old administrator token', async () => {
    db.prepare("UPDATE users SET role='viewer' WHERE id='operator'").run();
    const { socket, received } = await connect();
    const serverSocket = [...wss.clients][0];
    expect(wsService.getAuthenticatedClient(serverSocket)?.role).toBe('viewer');
    wsService.broadcastToAdmins({ type: WebSocketEventType.SYSTEM_HEALTH, payload: { secret: true }, timestamp: new Date().toISOString() });
    const pong = once(socket, 'pong'); socket.ping(); await pong;
    expect(received).toEqual([]);
  });

  it('organization switching retains session revocation across HTTP and live sockets', async () => {
    const pair = service.generateTokenPair(service.findUserById('operator')!);
    const response = await fetch(base + '/organizations/switch', {
      method: 'POST', headers: { authorization: `Bearer ${pair.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ organization_id: 'default' }),
    });
    expect(response.status).toBe(200);
    token = (await response.json() as { token: string }).token;
    expect(service.verifyToken(token)?.sid).toBe(service.verifyToken(pair.access_token)?.sid);
    const { socket, received } = await connect();
    service.revokeSessionFamily(pair.refresh_token);
    expect((await fetch(base + '/required', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    const closed = once(socket, 'close');
    wsService.broadcastToAuthenticated({ type: WebSocketEventType.SYSTEM_HEALTH, payload: { sensitive: true }, timestamp: new Date().toISOString() });
    expect((await closed)[0]).toBe(WS_CLOSE_CODES.AUTH_INVALID);
    expect(received).toEqual([]);
    expect(wsService.getClientCount()).toBe(0);
  });

  it.each(['assigned-org', 'default'])('rechecks selected %s organization membership on new and open sockets', async selected => {
    db.prepare("UPDATE users SET organization_id='assigned-org' WHERE id='operator'").run();
    const user = service.findUserById('operator')!;
    token = service.generateTokenPair({ ...user, organization_id: selected } as typeof user).access_token;
    const { socket, received } = await connect();
    db.prepare("UPDATE users SET organization_id='other-org' WHERE id='operator'").run();
    const allowed = wsService.authenticateConnection({ headers: { 'sec-websocket-protocol': `bearer.${token}` } });
    const message = { type: WebSocketEventType.SYSTEM_HEALTH, payload: { sensitive: true }, timestamp: new Date().toISOString() };
    if (selected === 'default') {
      expect(allowed?.organizationId).toBe('default');
      wsService.broadcastToAuthenticated(message);
      await vi.waitFor(() => expect(received).toEqual([message]));
    } else {
      expect(allowed).toBeNull();
      const closed = once(socket, 'close');
      wsService.broadcastToAuthenticated(message);
      expect((await closed)[0]).toBe(WS_CLOSE_CODES.AUTH_INVALID);
      expect(received).toEqual([]);
    }
  });

  it.each(['all', 'admin', 'owner', 'task', 'debate', 'direct'] as const)('%s delivery rejects an account disabled after connection', async channel => {
    const { socket, received } = await connect();
    const serverSocket = [...wss.clients][0];
    wsService.subscribeToDebate(serverSocket, 'fixture');
    db.prepare("UPDATE users SET is_active=0 WHERE id='operator'").run();
    const message = { type: WebSocketEventType.SYSTEM_HEALTH, payload: { sensitive: channel }, timestamp: new Date().toISOString() };
    const closed = vi.fn(); socket.on('close', closed);
    if (channel === 'all') wsService.broadcastToAuthenticated(message);
    if (channel === 'admin') wsService.broadcastToAdmins(message);
    if (channel === 'owner') wsService.broadcastToUser('operator', message);
    if (channel === 'task') wsService.broadcastTaskEvent({ owner_user_id: 'operator' }, message);
    if (channel === 'debate') wsService.broadcastDebateEvent('fixture', { type: 'comment', payload: message.payload, timestamp: message.timestamp });
    if (channel === 'direct') wsService.send(serverSocket, message);
    await vi.waitFor(() => expect(closed).toHaveBeenCalled(), { timeout: 700 });
    expect(closed.mock.calls[0][0]).toBe(WS_CLOSE_CODES.AUTH_INVALID);
    expect(received).toEqual([]);
    expect(wsService.getClientCount()).toBe(0);
  });

  it('closes an existing privileged socket when role changes without emitting an admin event', async () => {
    const { socket, received } = await connect();
    db.prepare("UPDATE users SET role='viewer' WHERE id='operator'").run();
    const closed = vi.fn(); socket.on('close', closed);
    wsService.broadcastToAdmins({ type: WebSocketEventType.SYSTEM_HEALTH, payload: { sensitive: true }, timestamp: new Date().toISOString() });
    await vi.waitFor(() => expect(closed).toHaveBeenCalled(), { timeout: 700 });
    expect(received).toEqual([]);
  });
});
