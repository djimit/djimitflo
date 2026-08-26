import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocketService } from '../services/websocket-service';
import { WS_CLOSE_CODES, UserRole, WebSocketEventType } from '@djimitflo/shared';
import type { AuthenticatedClient } from '@djimitflo/shared';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer } from 'http';
import { openAuthenticatedWebSocket } from '../../../dashboard/src/hooks/useWebSocket';

function mockAuthService(payload: any = null, user: any = null) {
  return {
    verifyToken: vi.fn().mockReturnValue(payload),
    findUserById: vi.fn().mockReturnValue(user),
  } as any;
}

function mockDb() {
  return {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue(null),
    }),
  } as any;
}

function mockReq(url: string) {
  return { url };
}

function createMockWs() {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  } as any;
}

function makeClient(role: UserRole, userId: string, tokenExp = Math.floor(Date.now() / 1000) + 3600): AuthenticatedClient {
  return { userId, email: `${userId}@test.com`, role, tokenExp };
}

describe('WebSocketService', () => {
  let wsService: WebSocketService;
  let authService: any;
  let db: any;
  let mockWss: any;

  beforeEach(() => {
    authService = mockAuthService();
    db = mockDb();
    mockWss = { on: vi.fn() };
    wsService = new WebSocketService(mockWss, authService, db);
  });

  describe('authenticateConnection', () => {
    it('rejects connection with no token', () => {
      const req = mockReq('/ws');
      const ws = createMockWs();
      const result = wsService.authenticateConnection(req, ws);
      expect(result).toBeNull();
      expect(ws.close).toHaveBeenCalledWith(WS_CLOSE_CODES.AUTH_REQUIRED, 'Authentication failed');
    });

    it('rejects connection with invalid token', () => {
      authService.verifyToken.mockReturnValue(null);
      const req = mockReq('/ws?token=invalid');
      const result = wsService.authenticateConnection(req);
      expect(result).toBeNull();
    });

    it('rejects connection with expired token', () => {
      const payload = { sub: 'user-1', email: 'a@test.com', role: 'maker', exp: Math.floor(Date.now() / 1000) - 100 };
      authService.verifyToken.mockReturnValue(payload);
      const req = mockReq('/ws?token=expired');
      const result = wsService.authenticateConnection(req);
      expect(result).toBeNull();
    });

    it('rejects connection with inactive user', () => {
      const payload = { sub: 'user-1', email: 'a@test.com', role: 'maker', exp: Math.floor(Date.now() / 1000) + 3600 };
      authService.verifyToken.mockReturnValue(payload);
      authService.findUserById.mockReturnValue(null);
      const req = mockReq('/ws?token=valid');
      const result = wsService.authenticateConnection(req);
      expect(result).toBeNull();
    });

    it('accepts connection with valid token and active user', () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const payload = { sub: 'user-1', email: 'admin@test.com', role: 'admin', exp };
      authService.verifyToken.mockReturnValue(payload);
      authService.findUserById.mockReturnValue({ id: 'user-1', isActive: true });
      const req = mockReq('/ws?token=validtoken');
      const result = wsService.authenticateConnection(req);
      expect(result).toEqual({
        userId: 'user-1',
        email: 'admin@test.com',
        role: 'admin',
        tokenExp: exp,
      });
    });
  });

  describe('broadcastFiltered', () => {
    it('sends only to clients matching filter', () => {
      const adminWs = createMockWs();
      const operatorWs = createMockWs();
      wsService['clients'].set(adminWs, makeClient(UserRole.ADMIN, 'admin-1'));
      wsService['clients'].set(operatorWs, makeClient(UserRole.OPERATOR, 'op-1'));

      const msg = { type: WebSocketEventType.SYSTEM_HEALTH, payload: {}, timestamp: new Date().toISOString() };
      wsService.broadcastFiltered(msg, (c) => c.role === UserRole.ADMIN);

      expect(adminWs.send).toHaveBeenCalled();
      expect(operatorWs.send).not.toHaveBeenCalled();
    });

    it('closes clients with expired tokens during broadcast', () => {
      const expiredWs = createMockWs();
      wsService['clients'].set(expiredWs, makeClient(UserRole.ADMIN, 'admin-1', Math.floor(Date.now() / 1000) - 100));

      const msg = { type: WebSocketEventType.SYSTEM_HEALTH, payload: {}, timestamp: new Date().toISOString() };
      wsService.broadcastFiltered(msg, () => true);

      expect(expiredWs.close).toHaveBeenCalledWith(WS_CLOSE_CODES.AUTH_EXPIRED, 'Token expired');
      expect(wsService['clients'].has(expiredWs)).toBe(false);
    });
  });

  describe('broadcastToAdmins', () => {
    it('sends only to admin clients', () => {
      const adminWs = createMockWs();
      const operatorWs = createMockWs();
      const viewerWs = createMockWs();
      wsService['clients'].set(adminWs, makeClient(UserRole.ADMIN, 'admin-1'));
      wsService['clients'].set(operatorWs, makeClient(UserRole.OPERATOR, 'op-1'));
      wsService['clients'].set(viewerWs, makeClient(UserRole.VIEWER, 'viewer-1'));

      const msg = { type: WebSocketEventType.SYSTEM_HEALTH, payload: {}, timestamp: new Date().toISOString() };
      wsService.broadcastToAdmins(msg);

      expect(adminWs.send).toHaveBeenCalled();
      expect(operatorWs.send).not.toHaveBeenCalled();
      expect(viewerWs.send).not.toHaveBeenCalled();
    });
  });

  describe('broadcastTaskEvent', () => {
    it('sends to admin and task owner, not to uninvolved operator', () => {
      const adminWs = createMockWs();
      const ownerWs = createMockWs();
      const otherWs = createMockWs();
      wsService['clients'].set(adminWs, makeClient(UserRole.ADMIN, 'admin-1'));
      wsService['clients'].set(ownerWs, makeClient(UserRole.OPERATOR, 'op-1'));
      wsService['clients'].set(otherWs, makeClient(UserRole.OPERATOR, 'op-2'));

      const task = { owner_user_id: 'op-1', created_by: 'op-1' };
      const msg = { type: WebSocketEventType.TASK_UPDATED, payload: { task }, timestamp: new Date().toISOString() };
      wsService.broadcastTaskEvent(task, msg);

      expect(adminWs.send).toHaveBeenCalled();
      expect(ownerWs.send).toHaveBeenCalled();
      expect(otherWs.send).not.toHaveBeenCalled();
    });

    it('sends to task creator when no owner_user_id', () => {
      const creatorWs = createMockWs();
      const otherWs = createMockWs();
      wsService['clients'].set(creatorWs, makeClient(UserRole.OPERATOR, 'creator-1'));
      wsService['clients'].set(otherWs, makeClient(UserRole.OPERATOR, 'other-1'));

      const task = { owner_user_id: null, created_by: 'creator-1' };
      const msg = { type: WebSocketEventType.TASK_UPDATED, payload: { task }, timestamp: new Date().toISOString() };
      wsService.broadcastTaskEvent(task, msg);

      expect(creatorWs.send).toHaveBeenCalled();
      expect(otherWs.send).not.toHaveBeenCalled();
    });

    it('sends to viewer who owns the task', () => {
      const viewerWs = createMockWs();
      const otherViewerWs = createMockWs();
      wsService['clients'].set(viewerWs, makeClient(UserRole.VIEWER, 'viewer-1'));
      wsService['clients'].set(otherViewerWs, makeClient(UserRole.VIEWER, 'viewer-2'));

      const task = { owner_user_id: 'viewer-1', created_by: 'viewer-1' };
      const msg = { type: WebSocketEventType.TASK_UPDATED, payload: { task }, timestamp: new Date().toISOString() };
      wsService.broadcastTaskEvent(task, msg);

      expect(viewerWs.send).toHaveBeenCalled();
      expect(otherViewerWs.send).not.toHaveBeenCalled();
    });
  });

  describe('broadcastToUser', () => {
    it('sends only to specified user', () => {
      const targetWs = createMockWs();
      const otherWs = createMockWs();
      wsService['clients'].set(targetWs, makeClient(UserRole.OPERATOR, 'target-1'));
      wsService['clients'].set(otherWs, makeClient(UserRole.OPERATOR, 'other-1'));

      const msg = { type: WebSocketEventType.SYSTEM_HEALTH, payload: {}, timestamp: new Date().toISOString() };
      wsService.broadcastToUser('target-1', msg);

      expect(targetWs.send).toHaveBeenCalled();
      expect(otherWs.send).not.toHaveBeenCalled();
    });
  });

  describe('broadcastToAuthenticated', () => {
    it('sends to all authenticated clients', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      wsService['clients'].set(ws1, makeClient(UserRole.ADMIN, 'user-1'));
      wsService['clients'].set(ws2, makeClient(UserRole.OPERATOR, 'user-2'));

      const msg = { type: WebSocketEventType.SYSTEM_HEALTH, payload: {}, timestamp: new Date().toISOString() };
      wsService.broadcastToAuthenticated(msg);

      expect(ws1.send).toHaveBeenCalled();
      expect(ws2.send).toHaveBeenCalled();
    });

    it('does not add data when a client is backpressured', () => {
      const ws = createMockWs();
      ws.bufferedAmount = 2 * 1024 * 1024;
      wsService['clients'].set(ws, makeClient(UserRole.ADMIN, 'user-1'));
      wsService.broadcastToAuthenticated({ type: WebSocketEventType.SYSTEM_HEALTH, payload: {}, timestamp: new Date().toISOString() });
      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  describe('getClientCount', () => {
    it('returns count of authenticated clients', () => {
      wsService['clients'].set(createMockWs(), makeClient(UserRole.ADMIN, 'a'));
      wsService['clients'].set(createMockWs(), makeClient(UserRole.OPERATOR, 'b'));
      expect(wsService.getClientCount()).toBe(2);
    });
  });
});

describe('WS_CLOSE_CODES', () => {
  it('has expected close codes', () => {
    expect(WS_CLOSE_CODES.AUTH_REQUIRED).toBe(4001);
    expect(WS_CLOSE_CODES.AUTH_INVALID).toBe(4002);
    expect(WS_CLOSE_CODES.AUTH_EXPIRED).toBe(4003);
    expect(WS_CLOSE_CODES.FORBIDDEN).toBe(4004);
  });
});

describe('WebSocket authentication handshake', () => {
  async function connect(path: string, protocol?: string) {
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
    const payload = { sub: 'user-1', email: 'user@test.com', role: UserRole.MAKER, exp: Math.floor(Date.now() / 1000) + 60 };
    new WebSocketService(wss, mockAuthService(payload, { id: 'user-1', isActive: true }), mockDb());
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('listener unavailable');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}${path}`, protocol);
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    return { socket, close: async () => { socket.close(); wss.close(); await new Promise<void>(resolve => httpServer.close(() => resolve())); } };
  }

  it('accepts the dashboard bearer subprotocol without a query token', async () => {
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
    const payload = { sub: 'user-1', email: 'user@test.com', role: UserRole.MAKER, exp: Math.floor(Date.now() / 1000) + 60 };
    new WebSocketService(wss, mockAuthService(payload, { id: 'user-1', isActive: true }), mockDb());
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('listener unavailable');
    const socket = openAuthenticatedWebSocket(`ws://127.0.0.1:${address.port}/ws`, 'validtoken', WebSocket as any) as WebSocket;
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    expect(socket.protocol).toBe('bearer.validtoken');
    socket.close();
    wss.close();
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
  });

  it('keeps the query-string token fallback', async () => {
    const connection = await connect('/ws?token=validtoken');
    expect(connection.socket.readyState).toBe(WebSocket.OPEN);
    await connection.close();
  });
});
