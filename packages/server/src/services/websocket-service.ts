/**
 * WebSocket service for real-time updates
 */

import type { IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { WebSocketMessage, WebSocketEventType } from '@djimitflo/shared';
import type { AuthService } from './auth-service';

export class WebSocketService {
  private wss: WebSocketServer;
  private authService: AuthService;
  private clients: Set<WebSocket> = new Set();

  constructor(wss: WebSocketServer, authService: AuthService) {
    this.wss = wss;
    this.authService = authService;
    this.setupServer();
  }
  
  private setupServer() {
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      if (!this.isAuthenticated(req)) {
        ws.close(1008, 'Unauthorized');
        return;
      }

      console.log('🔌 WebSocket client connected');
      this.clients.add(ws);
      
      // Send welcome message
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
        console.log('🔌 WebSocket client disconnected');
        this.clients.delete(ws);
      });
      
      ws.on('error', (error) => {
        console.error('🔌 WebSocket error:', error);
        this.clients.delete(ws);
      });
    });
  }
  
  /**
   * Verifies the JWT supplied as a `token` query parameter on the WebSocket
   * upgrade request. Browsers cannot set headers on WebSocket connections, so
   * the token must travel in the query string.
   */
  private isAuthenticated(req: IncomingMessage): boolean {
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      const token = url.searchParams.get('token');
      if (!token) return false;
      const payload = this.authService.verifyToken(token);
      if (!payload) return false;
      const user = this.authService.findUserById(payload.sub);
      return Boolean(user && user.isActive);
    } catch {
      return false;
    }
  }

  /**
   * Send message to a specific client
   */
  send(client: WebSocket, message: WebSocketMessage) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  }
  
  /**
   * Broadcast message to all connected clients
   */
  broadcast(message: WebSocketMessage) {
    const data = JSON.stringify(message);
    this.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  }
  
  /**
   * Get number of connected clients
   */
  getClientCount(): number {
    return this.clients.size;
  }
}
