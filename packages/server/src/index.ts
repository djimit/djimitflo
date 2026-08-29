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
import { createMetricsHandler, metricsRateLimiter } from './routes/metrics';
import { WebSocketService } from './services/websocket-service';
import { ExecutionEngine } from './execution/execution-engine';
import { MemorySyncService } from './services/memory-sync-service';
import { ReasoningBankService } from './services/reasoning-bank-service';
import { VectorMemoryService } from './services/vector-memory-service';
import { TrajectoryStore } from './services/trajectory-store';
import { RetentionService } from './services/retention-service';
import { MetaOrchestrationService } from './services/meta-orchestration-service';
import { SelfModificationPipeline } from './services/self-modification-pipeline';
import { ProactiveMemoryService } from './services/proactive-memory-service';
import { ComplianceAuditService } from './services/compliance-audit-service';
import { OpenMythosNightlyService } from './services/openmythos-nightly-service';
import { CognitiveLoopClosureService } from './services/cognitive-loop-closure-service';
import { MultiModelIntelligence } from './services/multi-model-intelligence';
import { LoopService } from './services/loop-service';
import { LoopDaemon } from './services/loop-daemon';
import { SelfModelService } from './services/self-model-service';
import { RuntimeGovernanceService } from './services/runtime-governance-service';
import { resolveRuntimeProfile, runtimeProfileEnablesAutonomy, runtimeProfileEnablesOperator } from './config/runtime-profile';
import { initOperatorServices } from './bootstrap/operator-services';
import { initAutonomousServices } from './bootstrap/autonomous-services';
import { DennisAgentService } from './services/dennis-agent-service';

type TelegramBotConfig = { token: string; machineId: string; agentType: string; hostIp: string; name: string };

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';
const RANSOMWARE_MODULE_ENABLED = process.env.RANSOMWARE_MODULE_ENABLED !== 'false';
const RANSOMWARE_MODULE_MODE = process.env.RANSOMWARE_MODULE_MODE || 'detect';

if (RANSOMWARE_MODULE_ENABLED) {
  console.log(`🛡️  Anti-agentic ransomware module active (mode: ${RANSOMWARE_MODULE_MODE})`);
}

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
  const runtimeProfile = resolveRuntimeProfile();
  const operatorRuntime = runtimeProfileEnablesOperator(runtimeProfile);
  const autonomousRuntime = runtimeProfileEnablesAutonomy(runtimeProfile);
  console.log(`🧭 Runtime profile: ${runtimeProfile}`);
  
  // Initialize database
  console.log('📦 Initializing database...');
  const db = initializeDatabase();

  // Recover in-flight loops orphaned by a previous crash/restart and prune stale worktrees.
  // At startup the in-memory lease map is empty, so any DB-'running' lease/run is orphaned.
  // G138: SelfModel service for confidence calibration (used by calibrated runtime selection)
  new SelfModelService(db);

  const recoverySvc = new LoopService(db);
  try {
    const recovery = recoverySvc.recoverInterruptedRuns();
    if (recovery.interruptedRuns || recovery.failedLeases || recovery.prunedWorktrees) {
      console.log(
        `🔄 Recovered ${recovery.interruptedRuns} interrupted run(s), ${recovery.failedLeases} orphaned lease(s), pruned ${recovery.prunedWorktrees} worktree(s).`,
      );
    }
  } catch (error) {
    console.warn('⚠️  Loop recovery failed (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  if (operatorRuntime) initOperatorServices(db);
  if (autonomousRuntime) {
    initAutonomousServices(db, recoverySvc);
    // Share the same LoopService instance so daemon and API share runtime leases.
    try {
      const daemon = new LoopDaemon(db, recoverySvc);
      daemon.start();
      console.log(`🚀 Loop daemon started (continuous goal queue, poll=${process.env.GOAL_QUEUE_POLL_MS || '5000'}ms).`);
    } catch (error) {
      console.warn('⚠️  Loop daemon failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
    }
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
    origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:5173', 'http://127.0.0.1:5173'],
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
  // handleProtocols echoes back the "bearer.<token>" subprotocol the dashboard
  // client offers (see packages/dashboard/src/hooks/useWebSocket.ts) so the
  // handshake response names the negotiated protocol per RFC 6455 §4.2.2.
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    handleProtocols: (protocols: Set<string>) => {
      for (const protocol of protocols) {
        if (protocol.startsWith('bearer.')) return protocol;
      }
      const [first] = protocols;
      return first ?? false;
    },
  });
  const wsService = new WebSocketService(wss, authService, db);
  console.log('🔌 WebSocket server initialized (authenticated)');

  let dennisQueueTimer: NodeJS.Timeout | undefined;
  if (operatorRuntime) {
    const dennisAgent = new DennisAgentService(db, { wsService });
    const processDennisQueue = () => {
      try {
        dennisAgent.processGovernedQueue();
      } catch (error) {
        console.warn('⚠️ Dennis governed queue failed:', error instanceof Error ? error.message : String(error));
      }
    };
    processDennisQueue();
    dennisQueueTimer = setInterval(processDennisQueue, 60_000);
    dennisQueueTimer.unref();
  }
  
  // Prometheus exposition — default-off, armed by METRICS_TOKEN (see routes/metrics.ts)
  app.get('/metrics', metricsRateLimiter, createMetricsHandler(db, () => wsService.getClientCount()));

  // One persistent runtime-governance authority shared by dispatch and API routes.
  const runtimeGovernance = new RuntimeGovernanceService(db);
  runtimeGovernance.start();
  const executionEngine = new ExecutionEngine(db, wsService, undefined, runtimeGovernance);
  console.log('⚙️  Execution engine initialized');

  const memorySync = new MemorySyncService(db);
  executionEngine.setMemorySyncService(memorySync);

  const reasoningBank = new ReasoningBankService(db);
  executionEngine.setReasoningBankService(reasoningBank);

  // Local hash-vector memory with self-learning feedback
  const vectorMemory = new VectorMemoryService(db);
  reasoningBank.setVectorMemory(vectorMemory);

  // ruvnet capabilities: trajectory bridge for execution learning
  const trajectoryStore = new TrajectoryStore(db);
  executionEngine.setTrajectoryStore(trajectoryStore);

  // Retention service — centralized data lifecycle management
  if (operatorRuntime) {
    const retention = new RetentionService(db);
    retention.start();
    const cognitiveLoopClosure = new CognitiveLoopClosureService(db);
    cognitiveLoopClosure.start();
  }

  // Multi-model intelligence — capability-aware model routing
  const multiModelIntelligence = new MultiModelIntelligence(db);
  // Seed default models if none exist
  if (multiModelIntelligence.getStatus().totalModels === 0) {
    multiModelIntelligence.registerModel({ modelId: 'workstation-litellm/coding', modelName: 'LiteLLM Coding', provider: 'litellm', costPerMtok: 1.0 });
    multiModelIntelligence.registerModel({ modelId: 'ollama-qwen25-14b', modelName: 'Qwen2.5 14B', provider: 'ollama', costPerMtok: 0 });
  }

  // Meta-orchestration — self-driving optimization layer (connects all learning subsystems)
  let metaOrchestration: MetaOrchestrationService | undefined;
  if (autonomousRuntime) {
    metaOrchestration = new MetaOrchestrationService(db);
    metaOrchestration.start();
    executionEngine.setMetaOrchestration(metaOrchestration);
    recoverySvc.setMetaOrchestration(metaOrchestration);
    new SelfModificationPipeline(db).analyze();
  }

  // Proactive memory — relevance-scored, self-maintaining memory substrate (Vector 4)
  // Compliance audit — immutable evidence chain and compliance reporting (Vector 7)
  // Constructed for startup side-effects (table setup / event registration).
  new ProactiveMemoryService(db);
  new ComplianceAuditService(db);

  // OpenMythos nightly eval — fills the governance leaderboard (default-off, see service header)
  if (autonomousRuntime && new OpenMythosNightlyService(db).start()) {
    console.log('🌙 OpenMythos nightly eval scheduler armed');
  }

  // API routes
  app.use('/api', createRoutes(db, executionEngine, authService, auth, wsService, metaOrchestration, operatorRuntime, runtimeGovernance));

  if (operatorRuntime) try {
    const raw = process.env.TELEGRAM_BOTS_CONFIG;
    if (raw) {
      const configs = JSON.parse(raw) as TelegramBotConfig[];
      const { TelegramGatewayService } = await import('@djimitflo/telegram') as { TelegramGatewayService: new (c: TelegramBotConfig[], ops: any) => any };
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
    app.use((req, res, next) => {
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
    if (dennisQueueTimer) clearInterval(dennisQueueTimer);
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
