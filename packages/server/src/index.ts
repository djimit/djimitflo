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
import { lifecycleManager } from './services/lifecycle-manager';
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
import { NegotiationCoordinator } from './services/negotiation-coordinator';
import { CapabilityAcquisitionService } from './services/capability-acquisition';
import { MetaEvolutionService } from './services/meta-evolution-service';
import { NestedSpawnService } from './services/nested-spawn-service';
import { SwarmIntelligenceService } from './services/swarm-intelligence-service';
import { SelfModelService } from './services/self-model-service';
import { AutonomousGoalGenerator } from './services/autonomous-goal-generator';
import { ExpertSwarmOrchestrator } from './services/expert-swarm-orchestrator';
import { WorkerPool } from './services/worker-pool';
import { OkfKnowledgeUpdater } from './services/okf-knowledge-updater';
import { PromptIntelService } from './services/prompt-intel-service';
import { ServiceRefactoringAnalyzer } from './services/service-refactoring-analyzer';
import { EmergentSpecializationService } from './services/emergent-specialization-service';
import { RsiSafetyGuard } from './services/rsi-safety-guard';
import { resolveRuntimeProfile, runtimeProfileEnablesAutonomy, runtimeProfileEnablesOperator } from './config/runtime-profile';

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

  if (autonomousRuntime) {
    // G20+G23: start the negotiation coordinator + capability acquisition service.
    const intelligence = new SwarmIntelligenceService(db);
    const nestedSpawns = new NestedSpawnService(db, recoverySvc, { intelligence, controlUrl: process.env.DJIMITFLO_CONTROL_URL || '' });
    try {
      const coordinator = new NegotiationCoordinator(recoverySvc, nestedSpawns, intelligence);
      coordinator.start();
      lifecycleManager.register({ serviceName: 'NegotiationCoordinator', stop: () => (coordinator as any)?.stop?.() });
      console.log('🤝 Negotiation coordinator started (inter-agent help_request protocol).');
    } catch (error) {
      console.warn('⚠️  Negotiation coordinator failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
    }
    try {
      const acquisition = new CapabilityAcquisitionService(db, intelligence);
      acquisition.start();
      lifecycleManager.register({ serviceName: 'CapabilityAcquisition', stop: () => (acquisition as any)?.stop?.() });
      console.log('🧠 Capability acquisition service started (autonomous capability growth).');
    } catch (error) {
      console.warn('⚠️  Capability acquisition failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
    }

    // G32: start the meta-evolution service (periodic self-evaluation + pruning).
    try {
      const metaEvolution = new MetaEvolutionService(db, intelligence);
      metaEvolution.start();
      lifecycleManager.register({ serviceName: 'MetaEvolution', stop: () => (metaEvolution as any)?.stop?.() });
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

    // G93: initialize expert swarm orchestrator (knowledge acquisition + judging).
    // G103-G106: RSI Engine services
    try {
      const safetyGuard = new RsiSafetyGuard(db);
      const refactoringAnalyzer = new ServiceRefactoringAnalyzer(db);
      const emergentSpec = new EmergentSpecializationService(db);
      void safetyGuard;
      void refactoringAnalyzer;
      void emergentSpec;
      console.log('🧬 RSI Engine ready (Refactor + Safety + Specialization).');
    } catch (error) {
      console.warn('⚠️  RSI Engine initialization failed (non-fatal):', error instanceof Error ? error.message : String(error));
    }

    try {
      const workerPool = new WorkerPool({ concurrency: 10 });
      const okfUpdater = new OkfKnowledgeUpdater(db);
      void workerPool;
      void okfUpdater;
      new ExpertSwarmOrchestrator(db);
      console.log('🎓 Expert Swarm Orchestrator + WorkerPool + OKF Updater ready.');
    } catch (error) {
      console.warn('⚠️  Expert Swarm initialization failed (non-fatal):', error instanceof Error ? error.message : String(error));
    }

    // G16: start the continuous operation daemon (goal queue with priority scheduling).
    // Share the same LoopService instance (recoverySvc) so the daemon and the server
    // share in-memory state (runtimeSemaphore, runtimeLeases, etc.).
    let daemon: LoopDaemon | undefined;
    try {
      daemon = new LoopDaemon(db, recoverySvc);
      daemon.start();
      lifecycleManager.register({ serviceName: 'LoopDaemon', stop: () => daemon?.stop() });
      console.log(`🚀 Loop daemon started (continuous goal queue, poll=${process.env.GOAL_QUEUE_POLL_MS || '5000'}ms).`);
    } catch (error) {
      console.warn('⚠️  Loop daemon failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
    }
  } else {
    console.log('⏸️  Autonomous services disabled by runtime profile');
  }

  if (operatorRuntime) {
    // Prompt intelligence: ingest pending findings on startup
    try {
      const promptIntel = new PromptIntelService(db);
      lifecycleManager.register({ serviceName: 'PromptIntel', stop: () => (promptIntel as any)?.stop?.() });
      const pendingPath = process.env.PROMPT_INTEL_PENDING || (process.env.HOME || '/Users/djimit') + '/.djimit/roborev/paperclip-tasks.pending.jsonl';
      const result = promptIntel.ingestFromPending(pendingPath);
      if (result.imported > 0 || result.skipped > 0) {
        console.log(`🔍 PromptIntel: imported ${result.imported} findings, skipped ${result.skipped} (threshold filter)`);
      }
    } catch (error) {
      console.warn('⚠️  PromptIntel ingestion failed (non-fatal):', error instanceof Error ? error.message : String(error));
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

  // Local hash-vector memory with self-learning feedback
  const vectorMemory = new VectorMemoryService(db);
  reasoningBank.setVectorMemory(vectorMemory);

  // ruvnet capabilities: trajectory bridge for execution learning
  const trajectoryStore = new TrajectoryStore(db);
  executionEngine.setTrajectoryStore(trajectoryStore);

  if (operatorRuntime) {
    // Retention service — centralized data lifecycle management
    const retention = new RetentionService(db);
    retention.start();
    lifecycleManager.register({ serviceName: 'RetentionService', stop: () => (retention as any)?.stop?.() });

    // Cognitive loop closure — learns from loop execution outcomes
    const cognitiveLoopClosure = new CognitiveLoopClosureService(db);
    cognitiveLoopClosure.start();
    lifecycleManager.register({ serviceName: 'CognitiveLoopClosure', stop: () => (cognitiveLoopClosure as any)?.stop?.() });
  } else {
    console.log('⏸️  Operator background services disabled by runtime profile');
  }

  // Multi-model intelligence — capability-aware model routing
  const multiModelIntelligence = new MultiModelIntelligence(db);
  // Seed default models if none exist
  if (multiModelIntelligence.getStatus().totalModels === 0) {
    multiModelIntelligence.registerModel({ modelId: 'workstation-litellm/coding', modelName: 'LiteLLM Coding', provider: 'litellm', costPerMtok: 1.0 });
    multiModelIntelligence.registerModel({ modelId: 'ollama-qwen25-14b', modelName: 'Qwen2.5 14B', provider: 'ollama', costPerMtok: 0 });
  }

  let metaOrchestration: MetaOrchestrationService | undefined;
  if (autonomousRuntime) {
    // Meta-orchestration — self-driving optimization layer (connects all learning subsystems)
    metaOrchestration = new MetaOrchestrationService(db);
    metaOrchestration.start();
    lifecycleManager.register({ serviceName: 'MetaOrchestration', stop: () => (metaOrchestration as any)?.stop?.() });
    executionEngine.setMetaOrchestration(metaOrchestration);
    recoverySvc.setMetaOrchestration(metaOrchestration);

    // Self-modification pipeline — autonomous code improvement (analyze on startup)
    const selfModification = new SelfModificationPipeline(db);
    // Run initial analysis to detect improvement opportunities
    selfModification.analyze();
  }

  // Proactive memory — relevance-scored, self-maintaining memory substrate (Vector 4)
  // Compliance audit — immutable evidence chain and compliance reporting (Vector 7)
  // Constructed for startup side-effects (table setup / event registration).
  new ProactiveMemoryService(db);
  new ComplianceAuditService(db);

  // OpenMythos nightly eval — fills the governance leaderboard (default-off, see service header)
  if (new OpenMythosNightlyService(db).start()) {
    console.log('🌙 OpenMythos nightly eval scheduler armed');
  }

  // API routes
  app.use('/api', createRoutes(db, executionEngine, authService, auth, wsService, metaOrchestration, operatorRuntime));

  try {
    const raw = process.env.TELEGRAM_BOTS_CONFIG;
    if (raw && operatorRuntime) {
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
    } else if (raw) {
      console.log('ℹ️ TELEGRAM_BOTS_CONFIG gezet, maar Telegram gateway is uitgeschakeld door runtime profile');
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
  
  // Graceful shutdown via LifecycleManager
  lifecycleManager.initSignalHandlers(httpServer);
}

main().catch((error) => {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
});
