import { WebSocketServer, WebSocket } from 'ws';
import type { Database } from 'better-sqlite3';
import {
  WebSocketMessage,
  WebSocketEventType,
  WS_CLOSE_CODES,
  AuthenticatedClient,
  UserRole,
} from '@djimitflo/shared';
import type { AuthService } from './auth-service';
import { AuthorizationService } from './authorization-service';

type ClientFilter = (client: AuthenticatedClient) => boolean;

export class WebSocketService {
  private wss: WebSocketServer;
  private clients: Map<WebSocket, AuthenticatedClient> = new Map();
  private authService: AuthService;
  private db: Database;

  constructor(wss: WebSocketServer, authService: AuthService, db: Database) {
    this.wss = wss;
    this.authService = authService;
    this.db = db;
    this.setupServer();
  }

  private setupServer() {
    this.wss.on('connection', (ws: WebSocket, req: any) => {
      const client = this.authenticateConnection(req, ws);
      if (!client) {
        return;
      }

      console.log('🔌 WebSocket client connected');
      this.clients.set(ws, client);

      this.send(ws, {
        type: WebSocketEventType.SYSTEM_HEALTH,
        payload: {
          status: 'healthy',
          uptime_ms: process.uptime() * 1000,
          active_tasks: 0,
          active_agents: 0,
          memory_usage_mb: process.memoryUsage().heapUsed / 1024 / 1024,
          cpu_usage_percent: 0,
        },
        timestamp: new Date().toISOString(),
      });

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.on('error', () => {
        console.error('🔌 WebSocket error');
        this.clients.delete(ws);
      });
    });
  }

  private extractToken(req: any): string | null {
    const protocolHeader = req?.headers?.['sec-websocket-protocol'];
    if (typeof protocolHeader === 'string' && protocolHeader.length > 0) {
      const protocols = protocolHeader.split(',').map((p: string) => p.trim());
      const bearerProtocol = protocols.find((p: string) => p.startsWith('bearer.'));
      if (bearerProtocol) {
        return bearerProtocol.slice('bearer.'.length);
      }
    }

    try {
      const url = req?.url || '';
      const queryString = url.split('?')[1] || '';
      const params = new URLSearchParams(queryString);
      return params.get('token');
    } catch {
      return null;
    }
  }

  authenticateConnection(req: any, ws?: WebSocket): AuthenticatedClient | null {
    const token = this.extractToken(req);

    if (!token) {
      this.rejectPendingConnection(ws, WS_CLOSE_CODES.AUTH_REQUIRED);
      return null;
    }

    const payload = this.authService.verifyToken(token);
    if (!payload) {
      this.rejectPendingConnection(ws, WS_CLOSE_CODES.AUTH_INVALID);
      return null;
    }

    if (payload.exp && payload.exp < Date.now() / 1000) {
      this.rejectPendingConnection(ws, WS_CLOSE_CODES.AUTH_EXPIRED);
      return null;
    }

    const user = this.authService.findUserById(payload.sub);
    const organizationId = payload.organization_id ?? 'default';
    if (!user || !user.isActive || (organizationId !== 'default'
      && organizationId !== (user as typeof user & { organization_id?: string }).organization_id)) {
      this.rejectPendingConnection(ws, WS_CLOSE_CODES.AUTH_INVALID);
      return null;
    }

    return {
      userId: payload.sub,
      email: user.email,
      role: user.role,
      tokenExp: payload.exp || 0,
      ...(payload.sid === undefined ? {} : { sessionId: payload.sid }),
      organizationId,
    };
  }

  private rejectPendingConnection(ws: WebSocket | undefined, code: number) {
    ws?.close(code, 'Authentication failed');
  }

  send(client: WebSocket, message: WebSocketMessage) {
    if (client.readyState === WebSocket.OPEN && this.getAuthenticatedClient(client)) {
      client.send(JSON.stringify(message));
    }
  }

  broadcastToAuthenticated(message: WebSocketMessage) {
    this.broadcastFiltered(message, () => true);
  }

  broadcastFiltered(message: WebSocketMessage, filterFn: ClientFilter) {
    const data = JSON.stringify(message);
    const configuredLimit = Number(process.env.WS_MAX_BUFFERED_AMOUNT_BYTES ?? 1_048_576);
    const maxBufferedAmount = Number.isFinite(configuredLimit) && configuredLimit >= 0 ? configuredLimit : 1_048_576;
    this.clients.forEach((_clientInfo, ws) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const clientInfo = this.getAuthenticatedClient(ws);
      if (!clientInfo) return;
      if (filterFn(clientInfo)) {
        if (ws.bufferedAmount > maxBufferedAmount) return;
        ws.send(data);
      }
    });
  }

  broadcastTaskEvent(task: any, message: WebSocketMessage) {
    this.broadcastFiltered(message, (client) => {
      return AuthorizationService.canReadTask(
        { sub: client.userId, email: client.email, role: client.role } as any,
        task
      );
    });
  }

  broadcastTaskEventById(taskId: string, message: WebSocketMessage) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
    if (!row) return;
    const task = {
      ...row,
      tags: JSON.parse(row.tags || '[]'),
      metadata: JSON.parse(row.metadata || '{}'),
    };
    this.broadcastTaskEvent(task, message);
  }

  broadcastToAdmins(message: WebSocketMessage) {
    this.broadcastFiltered(message, (client) => client.role === UserRole.ADMIN);
  }

  broadcastToUser(userId: string, message: WebSocketMessage) {
    this.broadcastFiltered(message, (client) => client.userId === userId);
  }

  getClientCount(): number {
    return this.clients.size;
  }

  getAuthenticatedClient(ws: WebSocket): AuthenticatedClient | undefined {
    const client = this.clients.get(ws);
    if (!client) return undefined;
    if (client.tokenExp > 0 && client.tokenExp <= Date.now() / 1000) {
      ws.close(WS_CLOSE_CODES.AUTH_EXPIRED, 'Token expired');
      this.clients.delete(ws);
      return undefined;
    }
    const user = this.authService.findUserById(client.userId);
    // Rebind through a fresh connection after authority changes; never emit using stale privileges.
    if (!user?.isActive || user.role !== client.role || user.email !== client.email
      || ((client.organizationId ?? 'default') !== 'default'
        && client.organizationId !== (user as typeof user & { organization_id?: string }).organization_id)
      || (client.sessionId !== undefined && !this.authService.isSessionActive(client.userId, client.sessionId))) {
      ws.close(WS_CLOSE_CODES.AUTH_INVALID, 'Authentication failed');
      this.clients.delete(ws);
      return undefined;
    }
    return client;
  }

  /**
   * Subscribe a WebSocket client to a consensus debate.
   */
  subscribeToDebate(ws: WebSocket, debateId: string): void {
    const client = this.getAuthenticatedClient(ws);
    if (!client) return;

    // Store debate subscription in client metadata
    const subscriptions = (client as any).debateSubscriptions || new Set<string>();
    subscriptions.add(debateId);
    (client as any).debateSubscriptions = subscriptions;
  }

  /**
   * Unsubscribe a WebSocket client from a consensus debate.
   */
  unsubscribeFromDebate(ws: WebSocket, debateId: string): void {
    const client = this.clients.get(ws);
    if (!client) return;

    const subscriptions = (client as any).debateSubscriptions as Set<string>;
    if (subscriptions) {
      subscriptions.delete(debateId);
    }
  }

  /**
   * Broadcast a consensus debate event to all subscribed clients.
   */
  broadcastDebateEvent(debateId: string, event: {
    type: 'proposal' | 'vote' | 'resolution' | 'comment';
    payload: Record<string, unknown>;
    timestamp: string;
  }): void {
    const message: WebSocketMessage = {
      type: WebSocketEventType.SYSTEM_HEALTH, // Reuse existing type; will be extended in v8.1
      payload: { ...event, debateId },
      timestamp: event.timestamp,
    };

    this.broadcastFiltered(message, (clientInfo) => {
      const subscriptions = (clientInfo as any).debateSubscriptions as Set<string>;
      return !!subscriptions?.has(debateId);
    });
  }

  /**
   * Get the number of subscribers for a debate.
   */
  getDebateSubscriberCount(debateId: string): number {
    let count = 0;
    this.clients.forEach((clientInfo) => {
      const subscriptions = (clientInfo as any).debateSubscriptions as Set<string>;
      if (subscriptions && subscriptions.has(debateId)) {
        count++;
      }
    });
    return count;
  }
}
