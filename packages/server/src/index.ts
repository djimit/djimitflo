/**
 * Djimitflo Server
 * Express + TypeScript + SQLite backend for agent orchestration control plane
 */

import { setLlmLedger } from './services/model-selector';
import express from 'express';
import { installOutboundGuard, outboundViolation } from './utils/outbound-guard';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { existsSync } from 'fs';
import { join } from 'path';
import { initializeDatabase } from './database';
import { errorHandler } from './middleware/error-handler';
import { requestLogger } from './middleware/request-logger';
import { requestContext } from './middleware/request-context';
import { securityHeaders } from './middleware/security-headers';
import { createAuthMiddleware } from './middleware/auth';
import { AuthService } from './services/auth-service';
import { createRoutes } from './routes';
import { createExplorePublicRoutes } from './routes/explore-public';
import { createGitHubWebhookRoutes } from './routes/github-webhooks';
import { DjimitSecTriggerService } from './services/djimitsec-trigger-service';
import { createMetricsHandler, metricsRateLimiter } from './routes/metrics';
import { WebSocketService } from './services/websocket-service';
import { ExecutionEngine } from './execution/execution-engine';
import { MEMORY_DELIVERY_RECONCILE_MS, MemorySyncService } from './services/memory-sync-service';
import { ReasoningBankService } from './services/reasoning-bank-service';
import { VectorMemoryService } from './services/vector-memory-service';
import { TrajectoryStore } from './services/trajectory-store';
import { RetentionService } from './services/retention-service';
import { MetaOrchestrationService } from './services/meta-orchestration-service';
import { SelfModificationPipeline } from './services/self-modification-pipeline';
import { ProactiveMemoryService } from './services/proactive-memory-service';
import { ComplianceAuditService } from './services/compliance-audit-service';
import { ComplianceReportScheduler } from './services/compliance-report-scheduler';
import { SelfHealingScheduler } from './services/self-healing-scheduler';
import { SelfImprovementAutoReviewScheduler } from './services/self-improvement-auto-review-scheduler';
import { FrontierExpertScheduler } from './services/frontier-expert-scheduler';
import { SpecialistPanelBacklogScheduler } from './services/specialist-panel-backlog-scheduler';
import { MemoryCandidateReviewScheduler } from './services/memory-candidate-review-scheduler';
import { OpenMythosNightlyService } from './services/openmythos-nightly-service';
import { CognitiveLoopClosureService } from './services/cognitive-loop-closure-service';
import { MultiModelIntelligence } from './services/multi-model-intelligence';
import { LoopService } from './services/loop-service';
import { LoopDaemon } from './services/loop-daemon';
import { ExplainerFleetWorker } from './services/explainer-fleet-worker';
import { SelfModelService } from './services/self-model-service';
import { RuntimeGovernanceService } from './services/runtime-governance-service';
import { resolveRuntimeProfile, runtimeProfileEnablesAutonomy, runtimeProfileEnablesOperator } from './config/runtime-profile';
import { initExternalEventIngest, initOperatorServices } from './bootstrap/operator-services';
import { initAutonomousServices } from './bootstrap/autonomous-services';
import { DennisAgentService } from './services/dennis-agent-service';
import { TelegramApiService } from './services/telegram-api-service';
import { parseTelegramAllowedUsers, parseTelegramUserMap } from './routes/telegram';
import { noteScheduler, registerRestart, markRun } from './services/scheduler-registry';
import { laneIntervalMs, startDependencyLane } from './services/dependency-lane';
import { PROBE_INTERVAL_MS, startOllamaProbe } from './services/inference-failover';
import { SHIPPED_CODE_SCAN_INTERVAL_MS, startShippedCodeScan } from './services/shipped-code-scan';
import { SKILL_DISTILLATION_INTERVAL_MS, startSkillDistillation } from './services/skill-distillation';
import { CONTENT_DRAFTS_INTERVAL_MS, startContentDrafts } from './services/content-drafts';
import { buildProvenance } from './utils/build-provenance';
import { recordTreatmentEnvBoundaries } from './services/experiment-registry';
import { fleetDrift } from './utils/fleet-drift';

// Operator rule (2026-09-29): this server never calls the hosts in OUTBOUND_DENY_HOSTS (the workstation only pulls).
// §16 step 8: refusals are also counted in policy_violations (POLICY_VIOLATION_LOG=shadow) once the database is open.
let outboundViolationDb: ReturnType<typeof initializeDatabase> | null = null;
installOutboundGuard(process.env, undefined, (host) => { if (outboundViolationDb) outboundViolation(outboundViolationDb, host); });

type TelegramBotConfig = { token: string; machineId: string; agentType: string; hostIp: string; name: string; allowedUsers?: number[]; userMap?: Record<string, string> };

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
  outboundViolationDb = db;
  // UX-18: one model-call ledger for every server-side LLM call (call sites without a db handle record here)
  setLlmLedger(db);

  // Recover in-flight loops orphaned by a previous crash/restart and prune stale worktrees.
  // At startup the in-memory lease map is empty, so any DB-'running' lease/run is orphaned.
  // G138: SelfModel service for confidence calibration (used by calibrated runtime selection)
  new SelfModelService(db);

  const recoverySvc = new LoopService(db);
  try {
    const recovery = recoverySvc.recoverInterruptedRuns();
    if (recovery.interruptedRuns || recovery.failedLeases || recovery.prunedWorktrees) {
      console.log(
        `🔄 Recovered ${recovery.interruptedRuns} interrupted run(s), ${recovery.failedLeases} orphaned lease(s), settled ${recovery.settledRuns} deploy-restart zombie run(s), pruned ${recovery.prunedWorktrees} worktree(s).`,
      );
    }
  } catch (error) {
    console.warn('⚠️  Loop recovery failed (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  initExternalEventIngest(db);
  if (operatorRuntime) initOperatorServices(db);
  if (autonomousRuntime) {
    // A18: the process that runs the experiments records a period boundary when a treatment flag changed since its last boot
    try {
      for (const b of recordTreatmentEnvBoundaries(db)) console.warn(`🧪 period boundary: ${b.experiment_id} ${b.env_name} ${b.previous ?? '(unset)'} → ${b.current ?? '(unset)'}`);
    } catch (error) {
      console.warn('⚠️  Experiment period-boundary check failed (non-fatal):', error instanceof Error ? error.message : String(error));
    }
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
  // One reverse-proxy hop (nginx on the host) sets X-Forwarded-For; without this express-rate-limit
  // throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR and cannot key limits per client.
  app.set('trust proxy', 1);
  
  // Middleware
  app.use(securityHeaders);
  app.use(requestContext); // X-Request-ID on every response; the dashboard shows it on failed calls (UXE-08)
  app.use(cors({
    origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:5173', 'http://127.0.0.1:5173'],
    credentials: true,
  }));
  // Exact GitHub signature bytes must be consumed before the general JSON parser.
  // Existing intake is retained; explicitly configured scan-only repositories use the fixed native executor.
  const scanRuntime: { triggers?: DjimitSecTriggerService } = {};
  app.use('/github/webhook', createGitHubWebhookRoutes(db, () => scanRuntime.triggers));
  app.use(express.json());
  app.use(requestLogger);
  
  // Health check (public)
  app.get('/health', (_req, res) => {
    const build = buildProvenance();
    res.json({
      status: 'healthy',
      commit: build.commit,
      // Same build identity as /api/health so both liveness endpoints are attributable.
      build,
      // S3: fleet services (event bus, agent registry) whose deployed sources differ from main; null = not checked
      fleet_drift: fleetDrift(),
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
  let telegramGateway: { stopAll: () => Promise<void> } | null = null;
  if (operatorRuntime) {
    const dennisAgent = new DennisAgentService(db, { wsService });
    const processDennisQueue = () => {
      try {
        dennisAgent.processGovernedQueue();
      } catch (error) {
        console.warn('⚠️ Dennis governed queue failed:', error instanceof Error ? error.message : String(error));
      }
      try { if (scanRuntime.triggers) void scanRuntime.triggers.tick().then(() => markRun('djimitsec_repository_scan'), error => { markRun('djimitsec_repository_scan', error); console.warn('DjimitSec trigger tick held:', error instanceof Error ? error.message : String(error)); }); }
      catch (error) { markRun('djimitsec_repository_scan', error); console.warn('DjimitSec trigger tick held:', error instanceof Error ? error.message : String(error)); }
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
  scanRuntime.triggers = new DjimitSecTriggerService(db, executionEngine, wsService);
  noteScheduler('djimitsec_repository_scan', 'DJIMITSEC_SCAN_TRIGGERS', operatorRuntime && ['shadow', 'execute'].includes(process.env.DJIMITSEC_SCAN_TRIGGERS || ''), 60_000);
  const taskRecovery = executionEngine.recoverInterruptedTasks();
  if (taskRecovery.failedMockTasks || taskRecovery.heldTasks) {
    console.log(`🔄 Reconciled ${taskRecovery.failedMockTasks} interrupted mock task(s); ${taskRecovery.heldTasks} task(s) held for operator outcome reconciliation.`);
  }
  // RIR (LOOP_RESUME_INTERRUPTED, default off): after both the loop settle and the engine's recovery holds, re-queue this
  // boot's interrupted runs with a fresh maker; the daemon's next tick runs them through every gate again.
  if (autonomousRuntime) {
    try {
      const resume = recoverySvc.resumeInterruptedRuns();
      if (resume.mode !== 'off' && resume.details.length) console.log(`🔄 Resume interrupted runs (${resume.mode}): ${resume.resumed} resumed, ${resume.skipped} skipped.`);
    } catch (error) {
      console.warn('⚠️  Resume of interrupted runs failed (non-fatal):', error instanceof Error ? error.message : String(error));
    }
  }
  console.log('⚙️  Execution engine initialized');

  const memorySync = new MemorySyncService(db);
  executionEngine.setMemorySyncService(memorySync);
  // CODE-004 (MEMORY_DELIVERY_RECEIPTS=on): bounded reconciliation of failed/unknown memory legs at boot and on a tick
  registerRestart('memory_delivery_reconcile', () => { memorySync.stop(); memorySync.start(); });
  noteScheduler('memory_delivery_reconcile', 'MEMORY_DELIVERY_RECEIPTS', memorySync.start(), MEMORY_DELIVERY_RECONCILE_MS);

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
    const selfModification = new SelfModificationPipeline(db);
    selfModification.analyze();
    selfModification.autoPlan();
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

  // Compliance report scheduler — periodic reporting, in-process (default-off, see service header)
  const complianceReportSched = new ComplianceReportScheduler(db);
  registerRestart('compliance_report', () => { complianceReportSched.stop(); complianceReportSched.start(); }); // P0.1 bounded self-heal re-arm
  if (noteScheduler('compliance_report', 'COMPLIANCE_REPORT_SCHEDULER_ENABLED', complianceReportSched.start(), complianceReportSched.intervalHours() * 3_600_000)) {
    console.log('📋 Compliance report scheduler armed');
  }

  // Self-healing scheduler — periodic detect-and-fix (stale leases, etc.), in-process (default-off, see service header)
  const selfHealingSched = new SelfHealingScheduler(db);
  registerRestart('self_healing', () => { selfHealingSched.stop(); selfHealingSched.start(); }); // P0.1 bounded self-heal re-arm
  if (noteScheduler('self_healing', 'SELF_HEALING_SCHEDULER_ENABLED', selfHealingSched.start(), selfHealingSched.intervalMinutes() * 60_000)) {
    console.log('🩺 Self-healing scheduler armed');
  }

  // Self-improvement auto-review scheduler — LLM-generated specialist reviews
  // + autonomous goal-authorization, in-process (default-off, see service header)
  const selfImprovementAutoReviewSched = new SelfImprovementAutoReviewScheduler(db);
  registerRestart('self_improvement_auto_review', () => { selfImprovementAutoReviewSched.stop(); selfImprovementAutoReviewSched.start(); }); // P0.1 bounded self-heal re-arm
  if (noteScheduler('self_improvement_auto_review', 'SELF_IMPROVEMENT_AUTO_REVIEW_ENABLED', selfImprovementAutoReviewSched.start(), selfImprovementAutoReviewSched.intervalMinutes() * 60_000)) {
    console.log('🧭 Self-improvement auto-review scheduler armed');
  }

  // Frontier expert scheduler — automates discovery/enrichment/peer-review only;
  // stops below the registry's hard approval/activation governance wall,
  // in-process (default-off, gated on DJIMITFLO_FRONTIER_EXPERTS_ENABLED too, see service header)
  const frontierExpertsSched = new FrontierExpertScheduler(db);
  registerRestart('frontier_experts', () => { frontierExpertsSched.stop(); frontierExpertsSched.start(); }); // P0.1 bounded self-heal re-arm
  if (noteScheduler('frontier_experts', 'FRONTIER_EXPERTS_SCHEDULER_ENABLED', frontierExpertsSched.start(), frontierExpertsSched.intervalMinutes() * 60_000)) {
    console.log('🔭 Frontier expert scheduler armed');
  }

  // Specialist panel backlog scheduler — projects consensus_ready general
  // panels into real work items, in-process (default-off, see service header)
  const specialistPanelBacklogSched = new SpecialistPanelBacklogScheduler(db);
  registerRestart('specialist_panel_backlog', () => { specialistPanelBacklogSched.stop(); specialistPanelBacklogSched.start(); }); // P0.1 bounded self-heal re-arm
  if (noteScheduler('specialist_panel_backlog', 'SPECIALIST_PANEL_BACKLOG_ENABLED', specialistPanelBacklogSched.start(), specialistPanelBacklogSched.intervalMinutes() * 60_000)) {
    console.log('🗂️  Specialist panel backlog scheduler armed');
  }

  // Memory candidate review scheduler — real specialist-panel analysis for
  // auto-promotion + a self-improvement evolution loop on the criteria,
  // in-process (default-off, see service header)
  const memoryCandidateReviewSched = new MemoryCandidateReviewScheduler(db);
  registerRestart('memory_candidate_review', () => { memoryCandidateReviewSched.stop(); memoryCandidateReviewSched.start(); }); // P0.1 bounded self-heal re-arm
  if (noteScheduler('memory_candidate_review', 'MEMORY_CANDIDATE_REVIEW_ENABLED', memoryCandidateReviewSched.start(), memoryCandidateReviewSched.intervalMinutes() * 60_000)) {
    console.log('🧬 Memory candidate review scheduler armed');
  }

  // Dependency lane — verified Dependabot patch/minor merges, one per tick (DEPENDENCY_LANE_MODE=shadow|act, default off)
  let stopDependencyLane = startDependencyLane(db);
  registerRestart('dependency_lane', () => { stopDependencyLane?.(); stopDependencyLane = startDependencyLane(db); });
  if (noteScheduler('dependency_lane', 'DEPENDENCY_LANE_MODE', !!stopDependencyLane, laneIntervalMs())) {
    console.log(`📦 Dependency lane armed (${process.env.DEPENDENCY_LANE_MODE})`);
  }

  // OLLAMA_AUTO_FAILOVER=on: every 30 min, while Ollama is recorded as usage-limited, one tiny probe call clears the state on success
  let stopOllamaProbe = startOllamaProbe(db);
  registerRestart('inference_failover_probe', () => { stopOllamaProbe?.(); stopOllamaProbe = startOllamaProbe(db); });
  if (noteScheduler('inference_failover_probe', 'OLLAMA_AUTO_FAILOVER', !!stopOllamaProbe, PROBE_INTERVAL_MS)) {
    console.log('🛟 Ollama auto-failover probe armed');
  }

  // Shipped-code scan — daily parse-only scan of the installed runtime packages, evidence candidates only (SHIPPED_CODE_SCAN_MODE=shadow, default off)
  let stopShippedScan = startShippedCodeScan(db);
  registerRestart('shipped_code_scan', () => { stopShippedScan?.(); stopShippedScan = startShippedCodeScan(db); });
  if (noteScheduler('shipped_code_scan', 'SHIPPED_CODE_SCAN_MODE', !!stopShippedScan, SHIPPED_CODE_SCAN_INTERVAL_MS)) {
    console.log('🔎 Shipped-code scan armed (shadow)');
  }

  // Skill distillation — daily record-only skill / anti-pattern cards from attributed runs, never injected (SKILL_DISTILLATION_MODE=shadow, default off)
  let stopSkillDistillation = startSkillDistillation(db);
  registerRestart('skill_distillation', () => { stopSkillDistillation?.(); stopSkillDistillation = startSkillDistillation(db); });
  if (noteScheduler('skill_distillation', 'SKILL_DISTILLATION_MODE', !!stopSkillDistillation, SKILL_DISTILLATION_INTERVAL_MS)) {
    console.log('🧠 Skill distillation armed (shadow)');
  }

  // Content drafts (track C) — at most one EVE-V blog signal a day → verified MDX draft; on = draft PR on djimit/djimit.nl (CONTENT_DRAFTS_MODE, default off)
  let stopContentDrafts = startContentDrafts(db);
  registerRestart('content_drafts', () => { stopContentDrafts?.(); stopContentDrafts = startContentDrafts(db); });
  if (noteScheduler('content_drafts', 'CONTENT_DRAFTS_MODE', !!stopContentDrafts, CONTENT_DRAFTS_INTERVAL_MS)) {
    console.log(`📝 Content drafts armed (${process.env.CONTENT_DRAFTS_MODE})`);
  }

  // API routes
  app.use('/api', createRoutes(db, executionEngine, authService, auth, wsService, metaOrchestration, operatorRuntime, runtimeGovernance));

  // Public explore pages (unauthenticated, rate-limited)
  app.use('/explore', createExplorePublicRoutes(db));

  let fleetWorker: ExplainerFleetWorker | undefined;

  // Explainer fleet worker — runs in EVERY runtime profile (Codex P1 fix: the
  // earlier bootstrap-only mount made explainer jobs idle in api/operator mode).
  // Opt out with DJIMITFLO_EXPLAINER_AUTONOMY=false; kill-switch still pauses it.
  try {
    if (process.env.DJIMITFLO_EXPLAINER_AUTONOMY === 'false') {
      console.log('ℹ️  Explainer fleet worker disabled via DJIMITFLO_EXPLAINER_AUTONOMY=false');
    } else {
      fleetWorker = ExplainerFleetWorker.create(db);
      fleetWorker.start();
      console.log('📖 Explainer fleet worker started (production entry point, honors kill-switch).');
    }
  } catch (error) {
    console.warn('⚠️  Explainer fleet worker failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  if (operatorRuntime) try {
    const raw = process.env.TELEGRAM_BOTS_CONFIG;
    if (raw) {
      const configs = (JSON.parse(raw) as TelegramBotConfig[]).map(config => ({ ...config,
        allowedUsers: config.allowedUsers ?? parseTelegramAllowedUsers(process.env.TELEGRAM_ALLOWED_USERS),
        userMap: config.userMap ?? parseTelegramUserMap(process.env.TELEGRAM_USER_MAP),
      }));
      const { TelegramGatewayService } = await import('@djimitflo/telegram') as { TelegramGatewayService: new (c: TelegramBotConfig[], ops: any) => any };
      const tg = new TelegramGatewayService(configs, new TelegramApiService(authService, `http://127.0.0.1:${PORT}/api`));
      tg.startAll().catch((e: any) => console.warn('⚠️ Telegram startAll fout:', e?.message || e));
      // Retain for graceful shutdown: SIGTERM must call stopAll() so leases are
      // released (otherwise a restart sees EEXIST and skips polling forever).
      telegramGateway = tg;
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
    fleetWorker?.stop();
    // Upgraded sockets otherwise keep httpServer.close() waiting indefinitely.
    for (const socket of wss.clients) socket.close(1001, 'Server shutting down');
    const socketDeadline = setTimeout(() => {
      for (const socket of wss.clients) socket.terminate();
    }, 5_000);
    socketDeadline.unref();
    wss.close();
    if (dennisQueueTimer) clearInterval(dennisQueueTimer);
    if (telegramGateway) {
      void telegramGateway.stopAll().catch((e: unknown) => console.warn('⚠️ Telegram stopAll fout:', e));
    }
    httpServer.close(() => {
      clearTimeout(socketDeadline);
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
