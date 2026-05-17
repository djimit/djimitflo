/**
 * Djimitflo Server
 * Express + TypeScript + SQLite backend for agent orchestration control plane
 */

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { initializeDatabase } from './database';
import { errorHandler } from './middleware/error-handler';
import { requestLogger } from './middleware/request-logger';
import { createRoutes } from './routes';
import { WebSocketService } from './services/websocket-service';

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || 'localhost';

async function main() {
  console.log('🚀 Starting Djimitflo Server...');
  
  // Initialize database
  console.log('📦 Initializing database...');
  const db = initializeDatabase();
  
  // Create Express app
  const app = express();
  
  // Middleware
  app.use(cors({
    origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:5173'],
    credentials: true,
  }));
  app.use(express.json());
  app.use(requestLogger);
  
  // Health check
  app.get('/health', (_req, res) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });
  
  // API routes
  app.use('/api', createRoutes(db));
  
  // Error handler (must be last)
  app.use(errorHandler);
  
  // Create HTTP server
  const httpServer = createServer(app);
  
  // Create WebSocket server
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  new WebSocketService(wss);
  
  console.log('🔌 WebSocket server initialized');
  
  // Start server
  httpServer.listen(PORT, () => {
    console.log(`✅ Djimitflo Server running on http://${HOST}:${PORT}`);
    console.log(`🔌 WebSocket server running on ws://${HOST}:${PORT}/ws`);
    console.log(`📊 Dashboard: http://localhost:5173`);
  });
  
  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('⚠️  SIGTERM received, shutting down gracefully...');
    httpServer.close(() => {
      console.log('👋 Server closed');
      db.close();
      process.exit(0);
    });
  });
}

main().catch((error) => {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
});
