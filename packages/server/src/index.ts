/**
 * Djimitflo Server
 * Express + TypeScript + SQLite backend for agent orchestration control plane
 */

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
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
import { LoopService } from './services/loop-service';
import { SwarmStatusService } from './services/swarm-status-service';
import { LoopDaemon } from './services/loop-daemon';
import { NegotiationCoordinator } from './services/negotiation-coordinator';
import { CapabilityAcquisitionService } from './services/capability-acquisition';
import { MetaEvolutionService } from './services/meta-evolution-service';
import { NestedSpawnService } from './services/nested-spawn-service';
import { SwarmIntelligenceService } from './services/swarm-intelligence-service';
import { SelfModelService } from './services/self-model-service';
import { ExperienceRetrievalService } from './services/experience-retrieval-service';
import { AutonomousGoalGenerator } from './services/autonomous-goal-generator';

type TelegramBotConfig = { token: string; machineId: string; agentType: string; hostIp: string; name: string };

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

// L1: derive a default nested-spawn control URL so a runtime child (running on the
// same host) can call back to POST /api/swarms/spawns without operator config.
// 0.0.0.0 is a bind address, not a dial address — children dial the loopback.
// Operators override DJIMITFLO_CONTROL_URL explicitly (e.g. for Docker, where the
// child may need the container's reachable address rather than 127.0.0.1).
if (!process.env.DJIMITFLO_CONTROL_URL) {
  const dialHost = HOST === '0.0.0.0' || HOST === 'localhost' ? '127.0.0.1' : HOST;
  process.env.DJIMITFLO_CONTROL_URL = `http://${dialHost}:${PORT}/api/swarms/spawns`;
}

async function main() {
  console.log('🚀 Starting Djimitflo Server...');
  
  // Initialize database
  console.log('📦 Initializing database...');
  const db = initializeDatabase();

  // Recover in-flight loops orphaned by a previous crash/restart and prune stale worktrees.
  // At startup the in-memory lease map is empty, so any DB-'running' lease/run is orphaned.
  // G9: wire the fleet concurrency advisor — LoopService gets the recommended
  // concurrency from SwarmStatusService without a circular import. The advisor
  // is a lazy callback so fleetPools() is only called when the AIMD controller
  // needs the hard cap (not on every constructor).
  const swarmStatus = new SwarmStatusService(db);
  const concurrencyAdvisor = (): number | null => {
    try {
      const status = swarmStatus.getStatus();
      const pools = status.fleet_pools as Array<{ recommended_concurrency: number }>;
      if (!pools || pools.length === 0) return null;
      // Sum the recommended concurrency across all runtime pools.
      return pools.reduce((sum, p) => sum + (p.recommended_concurrency || 0), 0);
    } catch { return null; }
  };

  const selfModel = new SelfModelService(db);
  // ExperienceRetrievalService is instantiated within ContextInjectionService
  // when a db is available. The instance here is for future standalone use.
  const _experienceRetrieval = new ExperienceRetrievalService(db);
  void _experienceRetrieval;
  const recoverySvc = new LoopService(db, undefined, concurrencyAdvisor, selfModel);
  try {
    const recovery = recoverySvc.recoverInterruptedRuns();
    if (recovery.interruptedRuns || recovery.failedLeases || recovery.prunedWorktrees) {
      console.log(
        `🔄 Recovered ${recovery.interruptedRuns} interrupted run(s), ${recovery.failedLeases} orphaned lease(s), pruned ${recovery.prunedWorktrees} worktree(s).`,
      );
    }
    // G10: resume interrupted runs from their last checkpoint (crash recovery).
    const resumeResult = recoverySvc.resumeInterruptedRuns();
    if (resumeResult.resumed > 0 || resumeResult.boundedFailed > 0) {
      console.log(
        `🔄 Resumed ${resumeResult.resumed} run(s) from checkpoint, ${resumeResult.boundedFailed} bounded-failed.`,
      );
    }
  } catch (error) {
    console.warn('⚠️  Loop recovery failed (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  // G20+G23: start the negotiation coordinator + capability acquisition service.
  const intelligence = new SwarmIntelligenceService(db);
  const nestedSpawns = new NestedSpawnService(db, recoverySvc, { intelligence, controlUrl: process.env.DJIMITFLO_CONTROL_URL || '' });
  try {
    const coordinator = new NegotiationCoordinator(recoverySvc, nestedSpawns, intelligence);
    coordinator.start();
    console.log('🤝 Negotiation coordinator started (inter-agent help_request protocol).');
  } catch (error) {
    console.warn('⚠️  Negotiation coordinator failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }
  try {
    const acquisition = new CapabilityAcquisitionService(db, intelligence);
    acquisition.start();
    console.log('🧠 Capability acquisition service started (autonomous capability growth).');
  } catch (error) {
    console.warn('⚠️  Capability acquisition failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  // G32: start the meta-evolution service (periodic self-evaluation + pruning).
  try {
    const metaEvolution = new MetaEvolutionService(db, intelligence);
    metaEvolution.start();
    console.log('🔄 Meta-evolution service started (periodic self-evaluation + capability pruning).');
  } catch (error) {
    console.warn('⚠️  Meta-evolution failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  // G92: start the autonomous goal generator (self-improvement → goals → loop-daemon).
  try {
    const autonomousGoals = new AutonomousGoalGenerator(db);
    const generated = autonomousGoals.generateAll();
    if (generated.total > 0) {
      console.log(`🎯 Autonomous goals generated: ${generated.total} (${generated.improvements} improvements, ${generated.security} security, ${generated.curiosity} curiosity)`);
    }
  } catch (error) {
    console.warn('⚠️  Autonomous goal generation failed (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  // G16: start the continuous operation daemon (goal queue with priority scheduling).
  // Share the same LoopService instance (recoverySvc) so the daemon and the server
  // share in-memory state (runtimeSemaphore, runtimeLeases, etc.).
  try {
    const daemon = new LoopDaemon(db, recoverySvc);
    daemon.start();
    console.log(`🚀 Loop daemon started (continuous goal queue, poll=${process.env.GOAL_QUEUE_POLL_MS || '5000'}ms).`);
  } catch (error) {
    console.warn('⚠️  Loop daemon failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }
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

  const memorySync = new MemorySyncService(db);
  executionEngine.setMemorySyncService(memorySync);

  const reasoningBank = new ReasoningBankService(db);
  executionEngine.setReasoningBankService(reasoningBank);
  
  // API routes
  app.use('/api', createRoutes(db, executionEngine, authService, auth, wsService));

  try {
    const raw = process.env.TELEGRAM_BOTS_CONFIG;
    if (raw) {
      const configs = JSON.parse(raw) as TelegramBotConfig[];
      const { TelegramGatewayService } = require('@djimitflo/telegram') as { TelegramGatewayService: new (c: TelegramBotConfig[], ops: any) => any };
      const tg = new TelegramGatewayService(configs, {
        createTask: async (prompt: string, machineId: string) => {
          const id = randomUUID();
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

  try {
    const jitterMinutes = Math.floor(Math.random() * 180);
    const targetHour = 3 + Math.floor(jitterMinutes / 60);
    const targetMinute = jitterMinutes % 60;
    console.log(`🫀 Heartbeat window scheduled daily at ~${targetHour.toString().padStart(2, '0')}:${targetMinute.toString().padStart(2, '0')}`);
  } catch {}
  
  // Serve dashboard static files (Docker/production)
  const dashboardPath = process.env.DASHBOARD_PATH || join(__dirname, '../../dashboard/dist');
  const serveDashboard = process.env.DASHBOARD_SERVE_ENABLED !== 'false';
  if (!serveDashboard) {
    console.log('📱 Dashboard serving disabled — running in API-only mode');
  } else if (existsSync(dashboardPath)) {
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
    if (serveDashboard && existsSync(dashboardPath)) {
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
