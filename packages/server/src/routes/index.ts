/**
 * API routes aggregator
 */

import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Database } from 'better-sqlite3';
import { createTaskRoutes } from './tasks';
import { createAgentRoutes } from './agents';
import { createCatalogRoutes } from './catalog';
import { createMCPRoutes } from './mcp';
import { createApprovalRoutes } from './approvals';
import type { ExecutionEngine } from '../execution/execution-engine';
import { createPolicyRoutes } from './policies';
import { createRiskRoutes } from './risk';
import { createEvidenceRoutes } from './evidence';
import { createObservabilityRoutes } from './observability';
import { createKnowledgeRoutes } from './knowledge';
import { createFederationRoutes } from './federation';
import { createInterventionRoutes } from './intervention';
import { createRepositoryRoutes, createDiffRoutes } from './repositories';
import { createAuthRoutes } from './auth';
import type { AuthService } from '../services/auth-service';
import { AuditService } from '../services/audit-service';
import { securityHeaders } from '../middleware/security-headers';
import type { AuthMiddleware } from '../middleware/auth';
import { createBackupRoutes } from './backup';
import { createAuditRoutes } from './audit';
import { createAuthorityRoutes } from './authority';
import { createUsageRoutes } from './usage';
import { createDiscussionRoutes } from './discussions';
import { createExportRoutes } from './exports';
import { createMessageRoutes } from './messages';
import { createSkillRoutes } from './skills';
import { createLearningRoutes } from './learning';
import { getAppVersion } from '../utils/version';
import { createGoalRoutes } from './goals';
import { createLoopRoutes } from './loops';
import { createWorkItemRoutes } from './work-items';
import { createSwarmRoutes } from './swarms';
import { createSpawnRoutes } from './spawns';
import { createOpenMythosRoutes } from './openmythos';
import { createGymRoutes } from './gym';
import { createRemoteGymRoutes } from './remote-gym';
import { createRuntimeGovernanceRoutes } from './runtime-governance';
import { createCognitiveRoutes } from './cognitive';
import { createMemoryRoutes } from './memory';
import { createMemoryEvolutionRoutes } from './memory-evolution';
import { createSelfModificationRoutes } from './self-modification';
import { createFleetRoutes } from './fleet';
import { createMultiModelRoutes } from './multi-model';
import { createComplianceRoutes } from './compliance';
import { createTraceabilityRoutes } from './traceability';
import { createRetirementRoutes } from './retirement';
import { createRedTeamRoutes } from './red-team';
import { createPlatformRoutes } from './platform';
import { createAdvancedRoutes } from './advanced';
import { createHealthRoutes } from './health';
import { createLegalRoutes } from './legal';
import { createResearchRoutes } from './research';
import { createCanvasRoutes } from './canvas';
import { createTelegramRoutes } from './telegram';
import { TelegramApiService } from '../services/telegram-api-service';
import { createSBOMRoutes } from './sbom';
import { createGovernanceFeedbackRoutes } from './governance-feedback';
import { createRepositoryIndexRoutes } from './repository-index';
import { createExplainerRoutes } from './explainer';
import { createConsoleRoutes } from './console';
import { createApexRoutes } from './apex';
import { createAgentSocialRuntimeRoutes, createSwarmOrchestrationRoutes } from './swarm-orchestration';
import { createSelfImprovementRoutes } from './self-improvement';
import { createSwarmIntelRoutes } from './swarm-intel';
import { createAgiRoutes } from './agi';
import { createIntelligenceRoutes } from './intelligence';
import { createMetaOrchestrationRoutes } from './meta-orchestration';
import { createCouncilRoutes } from './council';
import { createSegmlRoutes } from './segml';
import { createSegmlFederationRoutes } from './segml-federation';
import { createSegmlLiteratureRoutes } from './segml-literature';
import { createSegmlFinetuningRoutes } from './segml-finetuning';
import { createSegmlL3Routes } from './segml-l3';
import { createSegmlL4Routes } from './segml-l4';
import { createSegmlL5Routes } from './segml-l5';
import { createSegmlProductionRoutes } from './segml-production';
import { createOrganizationRoutes } from './organizations';
import { createAuditLogRoutes } from './audit-logs';
import { limitBodySize } from '../middleware/input-validation';
import { UsageTelemetry } from '../services/usage-telemetry';
import { buildOpenApiSpec, collectRoutes, mountRoutes, type RouteMount } from '../utils/route-inventory';
import type { WebSocketService } from '../services/websocket-service';
import { CognitiveLoopClosureService } from '../services/cognitive-loop-closure-service';
import { RuntimeGovernanceService } from '../services/runtime-governance-service';

export function createRoutes(
  db: Database,
  executionEngine?: ExecutionEngine,
  authService?: AuthService,
  auth?: AuthMiddleware,
  wsService?: WebSocketService,
  metaOrchestration?: import('../services/meta-orchestration-service').MetaOrchestrationService,
  operatorRuntime?: boolean,
  runtimeGovernance = new RuntimeGovernanceService(db),
): Router {
  const router = Router();

  // Security: limit request body size to 1MB
  router.use(limitBodySize(1_000_000));

  if (!authService || !auth) {
    throw new Error('AUTH_MIDDLEWARE_REQUIRED');
  }

  const requireAuth = auth.requireAuth;
  // L3: the nested-spawn control endpoint admits EITHER a user JWT OR a scoped
  // spawn token (X-Spawn-Token) so a runtime child with no user session can still
  // POST /spawns and poll /spawns/:id/status. Mounted BEFORE /swarms (Express
  // matches in registration order) so the specific path wins over the generic
  // requireAuth mount. POST /spawns/root still requires write:swarm_action inside
  // the router, so a token-only child cannot create roots.
  const requireAuthOrSpawnToken = auth.requireAuthOrSpawnToken;
  const auditService = new AuditService(db);
  const cognitiveLoop = new CognitiveLoopClosureService(db);

  // Security headers
  router.use(securityHeaders);
  router.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false }));

  // S4: local usage counts (route pattern + page views only) so dormant surface can be measured before consolidation
  const telemetry = new UsageTelemetry(db);
  router.use(telemetry.middleware());
  router.get('/telemetry/usage', requireAuth, (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    res.json({ days, rows: telemetry.summary(days) });
  });
  router.post('/telemetry/pageview', requireAuth, (req, res) => {
    const page = typeof req.body?.path === 'string' ? req.body.path.replace(/\/[0-9a-f-]{8,}(?=\/|$)/gi, '/:id').slice(0, 120) : '';
    if (!/^\/[\w\-/:]*$/.test(page)) { res.status(400).json({ error: { message: 'path required', code: 'VALIDATION_ERROR' } }); return; }
    telemetry.count('page', page);
    res.status(204).end();
  });

  // API version (public)
  router.get('/version', (_req, res) => {
    res.json({
      version: getAppVersion(),
      name: 'Djimitflo API',
    });
  });

  // Declarative mount table — order matters (Express matches in registration
  // order: /swarms/spawns must precede /swarms; the '/' diff routes go where
  // they always did). The same table feeds the route inventory / openapi.json.
  const mounts: RouteMount[] = [
    // Auth routes (public + protected)
    { prefix: '/auth', middleware: [], router: createAuthRoutes(authService!, auth!, auditService) },
    // Protected routes
    { prefix: '/tasks', middleware: [requireAuth], router: createTaskRoutes(db, executionEngine, auth, wsService) },
    { prefix: '/agents', middleware: [requireAuth], router: createAgentRoutes(db, auth) },
    { prefix: '/catalog', middleware: [requireAuth], router: createCatalogRoutes(db, auth) },
    { prefix: '/mcp', middleware: [requireAuth], router: createMCPRoutes(db, auth) },
    { prefix: '/approvals', middleware: [requireAuth], router: createApprovalRoutes(db, executionEngine, auth, wsService) },
    { prefix: '/policies', middleware: [requireAuth], router: createPolicyRoutes(db, auth) },
    { prefix: '/risk', middleware: [requireAuth], router: createRiskRoutes(db, auth) },
    { prefix: '/evidence', middleware: [requireAuth], router: createEvidenceRoutes(db, auth!) },
    { prefix: '/observability', middleware: [requireAuth], router: createObservabilityRoutes(db, auth!) },
    // G15: authenticated knowledge-bus HTTP transport endpoints
    { prefix: '/knowledge', middleware: [requireAuth], router: createKnowledgeRoutes(auth!) },
    // G26: federation protocol endpoints (peer discovery, claim sharing, work distribution)
    { prefix: '/federation', middleware: [requireAuth], router: createFederationRoutes(db, auth!) },
  ];

  // Machine-readable API surface, derived from the mount table above.
  // express-rate-limit so CodeQL recognizes the limiter (same policy as /metrics).
  const openApiRateLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: false, legacyHeaders: false });
  let openApiSpec: Record<string, unknown> | null = null;
  router.get('/openapi.json', openApiRateLimiter, requireAuth, (_req, res) => {
    openApiSpec ??= buildOpenApiSpec(collectRoutes(router), { title: 'Djimitflo API', version: getAppVersion() });
    res.json(openApiSpec);
  });

  // G22: operator intervention (pause/resume/inject/override)
  mounts.push(
    { prefix: '/intervention', middleware: [requireAuth], router: createInterventionRoutes(db, auth!) },
    { prefix: '/goals', middleware: [requireAuth], router: createGoalRoutes(db, auth) },
    { prefix: '/loops', middleware: [requireAuth], router: createLoopRoutes(db, auth, undefined, executionEngine) },
    { prefix: '/work-items', middleware: [requireAuth], router: createWorkItemRoutes(db, auth) },
    // Nested spawn control: mount the specific /swarms/spawns path BEFORE the
    // generic /swarms requireAuth mount so children can reach it with a spawn token.
    { prefix: '/swarms/spawns', middleware: [requireAuthOrSpawnToken], router: createSpawnRoutes(db, auth, wsService) },
    // Signed runtime callbacks are scoped to an agent and mounted before the
    // generic authenticated swarm surface; no user JWT is accepted here.
    { prefix: '/swarm-v2/social-runtime', middleware: [], router: createAgentSocialRuntimeRoutes(db, runtimeGovernance) },
    { prefix: '/swarms', middleware: [requireAuth], router: createSwarmRoutes(db, auth, wsService) },
    { prefix: '/repositories', middleware: [requireAuth], router: createRepositoryRoutes(db, auth) },
    // Each diff handler authenticates itself. A '/' mount-level guard would also
    // intercept unrelated later public routes such as Telegram's secret webhook.
    { prefix: '/', middleware: [], router: createDiffRoutes(db, auth) },
    { prefix: '/audit', middleware: [requireAuth], router: createAuditRoutes(db, auditService, auth) },
    { prefix: '/authority', middleware: [requireAuth], router: createAuthorityRoutes(db, auth) },
    { prefix: '/discussions', middleware: [requireAuth], router: createDiscussionRoutes(db, auth, wsService) },
    { prefix: '/usage', middleware: [requireAuth], router: createUsageRoutes(db, auth) },
    { prefix: '/learning', middleware: [requireAuth], router: createLearningRoutes(db, auth, cognitiveLoop) },
    { prefix: '/backups', middleware: [requireAuth], router: createBackupRoutes(db, auth!) },
    { prefix: '/exports', middleware: [requireAuth], router: createExportRoutes(db, auth!) },
    { prefix: '/messages', middleware: [requireAuth], router: createMessageRoutes(db, wsService, auth) },
    { prefix: '/memory', middleware: [requireAuth], router: createMemoryRoutes(db, auth) },
    { prefix: '/memory-evolution', middleware: [requireAuth], router: createMemoryEvolutionRoutes(db, auth) },
    { prefix: '/skills', middleware: [requireAuth], router: createSkillRoutes(db, auth) },
    { prefix: '/openmythos', middleware: [requireAuth], router: createOpenMythosRoutes(db, auth) },
    { prefix: '/gym', middleware: [requireAuth], router: createGymRoutes(db, auth) },
    { prefix: '/gym-worker', middleware: [], router: createRemoteGymRoutes(db, auth) },
    { prefix: '/runtime-governance', middleware: [requireAuth], router: createRuntimeGovernanceRoutes(db, auth, runtimeGovernance) },
    { prefix: '/cognitive', middleware: [requireAuth], router: createCognitiveRoutes(db, auth, cognitiveLoop) },
    { prefix: '/self-modification', middleware: [requireAuth], router: createSelfModificationRoutes(db, auth) },
    { prefix: '/fleet', middleware: [requireAuth], router: createFleetRoutes(db, auth) },
    { prefix: '/models', middleware: [requireAuth], router: createMultiModelRoutes(db, auth) },
    { prefix: '/compliance', middleware: [requireAuth], router: createComplianceRoutes(db, auth) },
    { prefix: '/retirement', middleware: [requireAuth], router: createRetirementRoutes(db, auth) },
    { prefix: '/red-team', middleware: [requireAuth], router: createRedTeamRoutes(db, auth, runtimeGovernance) },
    { prefix: '/platform', middleware: [requireAuth], router: createPlatformRoutes(db, auth, runtimeGovernance) },
    { prefix: '/advanced', middleware: [requireAuth], router: createAdvancedRoutes(db, auth) },
    { prefix: '/health', middleware: [], router: createHealthRoutes(db, auth) },
    { prefix: '/legal', middleware: [requireAuth], router: createLegalRoutes(db, auth) },
    { prefix: '/research', middleware: [requireAuth], router: createResearchRoutes(db, auth) },
    { prefix: '/canvas', middleware: [requireAuth], router: createCanvasRoutes(db, auth) },
    { prefix: '/telegram', middleware: [], router: createTelegramRoutes(db, auth, wsService, new TelegramApiService(authService!, `http://127.0.0.1:${process.env.PORT || 3001}/api`)) },
    { prefix: '/apex', middleware: [requireAuth], router: createApexRoutes(db, auth, operatorRuntime) },
    { prefix: '/swarm-v2', middleware: [requireAuth], router: createSwarmOrchestrationRoutes(db, auth) },
    { prefix: '/swarm', middleware: [requireAuth], router: createSwarmOrchestrationRoutes(db, auth) },
    { prefix: '/self-improve', middleware: [requireAuth], router: createSelfImprovementRoutes(db, auth) },
    { prefix: '/swarm-intel', middleware: [requireAuth], router: createSwarmIntelRoutes(db, auth) },
    { prefix: '/agi', middleware: [requireAuth], router: createAgiRoutes(db, auth) },
    { prefix: '/intelligence', middleware: [requireAuth], router: createIntelligenceRoutes(db, auth) },
    { prefix: '/meta', middleware: [requireAuth], router: createMetaOrchestrationRoutes(db, auth, metaOrchestration) },
    { prefix: '/traceability', middleware: [rateLimit({ windowMs: 60_000, limit: 30 }), requireAuth], router: createTraceabilityRoutes() },
    { prefix: '/sbom', middleware: [requireAuth], router: createSBOMRoutes(db, auth) },
    { prefix: '/governance-feedback', middleware: [requireAuth], router: createGovernanceFeedbackRoutes(db, auth, wsService) },
    { prefix: '/repo-index', middleware: [requireAuth], router: createRepositoryIndexRoutes(db, auth) },
    { prefix: '/explainer', middleware: [requireAuth], router: createExplainerRoutes(db, auth) },
    { prefix: '/console', middleware: [requireAuth], router: createConsoleRoutes(db, auth) },
    { prefix: '/council', middleware: [requireAuth], router: createCouncilRoutes(db, auth) },
    { prefix: '/segml', middleware: [requireAuth], router: createSegmlRoutes(db, auth) },
    { prefix: '/segml/federation', middleware: [requireAuth], router: createSegmlFederationRoutes(db, auth) },
    { prefix: '/segml/literature', middleware: [requireAuth], router: createSegmlLiteratureRoutes(db, auth) },
    { prefix: '/segml/finetuning', middleware: [requireAuth], router: createSegmlFinetuningRoutes(db, auth) },
    { prefix: '/segml/l3', middleware: [requireAuth], router: createSegmlL3Routes(db, auth) },
    { prefix: '/segml/l4', middleware: [requireAuth], router: createSegmlL4Routes(db, auth) },
    { prefix: '/segml/l5', middleware: [requireAuth], router: createSegmlL5Routes(db, auth) },
    { prefix: '/segml/production', middleware: [requireAuth], router: createSegmlProductionRoutes(db, auth) },
    { prefix: '/organizations', middleware: [requireAuth], router: createOrganizationRoutes(db, requireAuth, authService, auditService) },
    { prefix: '/audit-logs', middleware: [requireAuth], router: createAuditLogRoutes(db, requireAuth) },
  );

  mountRoutes(router, mounts);

  return router;
}
