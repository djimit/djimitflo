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
import { MemorySyncService } from './services/memory-sync-service';
import { ReasoningBankService } from './services/reasoning-bank-service';
// Telegram gateway is optional; dynamic require used to avoid hard coupling
type TelegramBotConfig = { token: string; machineId: string; agentType: string; hostIp: string; name: string };


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

  // Memory sync service
  const memorySync = new MemorySyncService(db);
  executionEngine.setMemorySyncService(memorySync);

  // Reasoning bank service
  const reasoningBank = new ReasoningBankService(db);
  executionEngine.setReasoningBankService(reasoningBank);
  
  // API routes
  app.use('/api', createRoutes(db, executionEngine, authService, auth, wsService));

  // Telegram gateway bootstrap (config via env TELEGRAM_BOTS_CONFIG as JSON)
  try {
    const raw = process.env.TELEGRAM_BOTS_CONFIG;
    if (raw) {
      const configs = JSON.parse(raw) as TelegramBotConfig[];
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { TelegramGatewayService } = require('@djimitflo/telegram') as { TelegramGatewayService: new (c: TelegramBotConfig[], ops: any) => any };
      const tg = new TelegramGatewayService(configs, {
        createTask: async (prompt: string, machineId: string) => {
          const id = crypto.randomUUID();
          db.prepare(
            `INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, created_at, updated_at, created_by) VALUES (?, ?, ?, 'pending', 'medium', 'low', 'local', datetime('now'), datetime('now'), ?)`
          ).run(id, prompt.slice(0, 80) || 'Telegram Task', prompt, machineId);
          return id;
        },
        getStatus: async (machineId: string) => {
          const count = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status IN ('pending','queued','running') AND created_by = ?").get(machineId) as any).c;
          const agent = db.prepare('SELECT * FROM agents WHERE name = ?').get(machineId) as any;
          return `Machine ${machineId}: ${count} actieve/pending tasks. Status: ${agent?.status || 'unknown'}`;
        },
      });
      tg.startAll().catch((e: any) => console.warn('⚠️ Telegram startAll fout:', e?.message || e));
    } else {
      console.log('ℹ️ TELEGRAM_BOTS_CONFIG niet gezet — Telegram gateway is uitgeschakeld');
    }
  } catch (e) {
    console.warn('⚠️ Telegram gateway init fout:', e);
  }

  // Schedule daily heartbeat window (03:00–06:00) — jittered per process start
  try {
    const jitterMinutes = Math.floor(Math.random() * 180); // 0..179 minutes
    const targetHour = 3 + Math.floor(jitterMinutes / 60);
    const targetMinute = jitterMinutes % 60;
    console.log(`🫀 Heartbeat window scheduled daily at ~${targetHour.toString().padStart(2,'0')}:${targetMinute.toString().padStart(2,'0')}`);
  } catch {}
  
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
