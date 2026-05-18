/**
 * Djimitflo Server
 * Express + TypeScript + SQLite backend for agent orchestration control plane
 */

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { existsSync } from 'fs';
import { join } from 'path';
import { initializeDatabase } from './database';
import { errorHandler } from './middleware/error-handler';
import { requestLogger } from './middleware/request-logger';
import { createAuthMiddleware } from './middleware/auth';
import { AuthService } from './services/auth-service';
import { createRoutes } from './routes';
import { WebSocketService } from './services/websocket-service';
import { ExecutionEngine } from './execution/execution-engine';

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  console.log('🚀 Starting Djimitflo Server...');
  
  // Initialize database
  console.log('📦 Initializing database...');
  const db = initializeDatabase();
  
  // Initialize auth
  const authService = new AuthService(db);
  authService.bootstrapAdmin();
  const auth = createAuthMiddleware(authService);
  console.log('🔐 Authentication initialized');
  
  // Create Express app
  const app = express();
  
  // Middleware
  app.use(cors({
    origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:5173'],
    credentials: true,
  }));
  app.use(express.json());
  app.use(requestLogger);
  
  // Health check (public)
  app.get('/health', (_req, res) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });
  
  // Create HTTP server (needed for WebSocket)
  const httpServer = createServer(app);
  
  // Create WebSocket server
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  const wsService = new WebSocketService(wss, authService, db);
  console.log('🔌 WebSocket server initialized (authenticated)');
  
  // Create execution engine
  const executionEngine = new ExecutionEngine(db, wsService);
  console.log('⚙️  Execution engine initialized');
  
  // API routes
  app.use('/api', createRoutes(db, executionEngine, authService, auth));
  
  // Serve dashboard static files (Docker/production)
  const dashboardPath = process.env.DASHBOARD_PATH || join(__dirname, '../../dashboard/dist');
  if (existsSync(dashboardPath)) {
    console.log(`🖥️  Serving dashboard from ${dashboardPath}`);
    app.use(express.static(dashboardPath));
    
    // SPA fallback: serve index.html for non-API, non-WebSocket GET requests
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/ws') || req.path === '/health') {
        return next();
      }
      const acceptHeader = req.headers.accept || '';
      if (req.method === 'GET' && acceptHeader.includes('text/html')) {
        res.sendFile(join(dashboardPath, 'index.html'), (err) => {
          if (err) next(err);
        });
        return;
      }
      next();
    });
  } else {
    console.log('📱 Dashboard not found at', dashboardPath, '— running in API-only mode');
  }
  
  // Error handler (must be last)
  app.use(errorHandler);
  
  // Start server
  httpServer.listen(Number(PORT), HOST as string, () => {
    console.log(`✅ Djimitflo Server running on http://${HOST}:${PORT}`);
    console.log(`🔌 WebSocket server running on ws://${HOST}:${PORT}/ws`);
    if (existsSync(dashboardPath)) {
      console.log(`📊 Dashboard: http://localhost:${PORT}`);
    }
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
