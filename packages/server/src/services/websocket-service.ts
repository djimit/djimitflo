/**
 * WebSocket service for real-time updates
 */

import { WebSocketServer, WebSocket } from 'ws';
import { WebSocketMessage, WebSocketEventType } from '@djimitflo/shared';

export class WebSocketService {
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  
  constructor(wss: WebSocketServer) {
    this.wss = wss;
    this.setupServer();
  }
  
  private setupServer() {
    this.wss.on('connection', (ws: WebSocket) => {
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
