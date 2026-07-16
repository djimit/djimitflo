/**
 * API routes aggregator
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { hostname } from 'os';
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
import { createRuntimeGovernanceRoutes } from './runtime-governance';
import { createCognitiveRoutes } from './cognitive';
import { createMemoryRoutes } from './memory';
import { createSelfModificationRoutes } from './self-modification';
import { createFleetRoutes } from './fleet';
import { createMultiModelRoutes } from './multi-model';
import { createComplianceRoutes } from './compliance';
import { createRetirementRoutes } from './retirement';
import { createRedTeamRoutes } from './red-team';
import { createPlatformRoutes } from './platform';
import { createAdvancedRoutes } from './advanced';
import { createHealthRoutes } from './health';
import { createLegalRoutes } from './legal';
import { createResearchRoutes } from './research';
import { createCanvasRoutes } from './canvas';
import { createTelegramRoutes } from './telegram';
import { createApexRoutes } from './apex';
import { createSwarmOrchestrationRoutes } from './swarm-orchestration';
import { createSelfImprovementRoutes } from './self-improvement';
import { createSwarmIntelRoutes } from './swarm-intel';
import { createAgiRoutes } from './agi';
import { createIntelligenceRoutes } from './intelligence';
import { createMetaOrchestrationRoutes } from './meta-orchestration';
import { limitBodySize } from '../middleware/input-validation';
import rateLimit from 'express-rate-limit';
import { buildOpenApiSpec, collectRoutes, type RouteMount } from '../utils/route-inventory';
import type { WebSocketService } from '../services/websocket-service';

export function createRoutes(
  db: Database,
  executionEngine?: ExecutionEngine,
  authService?: AuthService,
  auth?: AuthMiddleware,
  wsService?: WebSocketService,
  metaOrchestration?: import('../services/meta-orchestration-service').MetaOrchestrationService
): Router {
  const router = Router();

  // Security: limit request body size to 1MB
  router.use(limitBodySize(1_000_000));

  if (!authService || !auth) {
    console.warn('WARNING: Running without authentication. All routes are unprotected.');
  }

  const requireAuth = auth?.requireAuth ?? ((_req: any, _res: any, next: any) => next());
  // L3: the nested-spawn control endpoint admits EITHER a user JWT OR a scoped
  // spawn token (X-Spawn-Token) so a runtime child with no user session can still
  // POST /spawns and poll /spawns/:id/status. Mounted BEFORE /swarms (Express
  // matches in registration order) so the specific path wins over the generic
  // requireAuth mount. POST /spawns/root still requires write:swarm_action inside
  // the router, so a token-only child cannot create roots.
  const requireAuthOrSpawnToken = auth?.requireAuthOrSpawnToken ?? ((_req: any, _res: any, next: any) => next());
  const auditService = new AuditService(db);

  // Security headers
  router.use(securityHeaders);

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
    { prefix: '/tasks', middleware: [requireAuth], router: createTaskRoutes(db, executionEngine, auth) },
    { prefix: '/agents', middleware: [requireAuth], router: createAgentRoutes(db, auth) },
    { prefix: '/catalog', middleware: [requireAuth], router: createCatalogRoutes(db, auth) },
    { prefix: '/mcp', middleware: [requireAuth], router: createMCPRoutes(db, auth) },
    { prefix: '/approvals', middleware: [requireAuth], router: createApprovalRoutes(db, executionEngine, auth) },
    { prefix: '/policies', middleware: [requireAuth], router: createPolicyRoutes(db, auth) },
    { prefix: '/risk', middleware: [requireAuth], router: createRiskRoutes(db, auth) },
    { prefix: '/evidence', middleware: [requireAuth], router: createEvidenceRoutes(db, auth!) },
    { prefix: '/observability', middleware: [requireAuth], router: createObservabilityRoutes(db, auth!) },
    // G15: knowledge bus HTTP endpoints (federation transport scaffold)
    { prefix: '/knowledge', middleware: [requireAuth], router: createKnowledgeRoutes(auth!) },
    // G26: federation protocol endpoints (peer discovery, claim sharing, work distribution)
    { prefix: '/federation', middleware: [requireAuth], router: createFederationRoutes(db, auth!) },
  ];

  // D2: runtime URLs — use the host OS' native listener inventory.
  router.get('/workstation/urls', requireAuth, (_req: any, res: any) => {
    try {
      res.json({ host: hostname(), platform: process.platform, ports: scanListeningPorts() });
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : 'Failed to scan listening ports' });
    }
  });

  // G22: operator intervention (pause/resume/inject/override)
  mounts.push(
    { prefix: '/intervention', middleware: [requireAuth], router: createInterventionRoutes(db, auth!) },
    { prefix: '/goals', middleware: [requireAuth], router: createGoalRoutes(db, auth) },
    { prefix: '/loops', middleware: [requireAuth], router: createLoopRoutes(db, auth) },
    { prefix: '/work-items', middleware: [requireAuth], router: createWorkItemRoutes(db, auth) },
    // Nested spawn control: mount the specific /swarms/spawns path BEFORE the
    // generic /swarms requireAuth mount so children can reach it with a spawn token.
    { prefix: '/swarms/spawns', middleware: [requireAuthOrSpawnToken], router: createSpawnRoutes(db, auth, wsService) },
    { prefix: '/swarms', middleware: [requireAuth], router: createSwarmRoutes(db, auth, wsService) },
    { prefix: '/repositories', middleware: [requireAuth], router: createRepositoryRoutes(db, auth) },
    { prefix: '/', middleware: [requireAuth], router: createDiffRoutes(db, auth) },
    { prefix: '/audit', middleware: [requireAuth], router: createAuditRoutes(db, auditService, auth) },
    { prefix: '/discussions', middleware: [requireAuth], router: createDiscussionRoutes(db, auth, wsService) },
    { prefix: '/usage', middleware: [requireAuth], router: createUsageRoutes(db, auth) },
    { prefix: '/learning', middleware: [requireAuth], router: createLearningRoutes(db, auth) },
    { prefix: '/backups', middleware: [requireAuth], router: createBackupRoutes(db, auth!) },
    { prefix: '/exports', middleware: [requireAuth], router: createExportRoutes(db, auth!) },
    { prefix: '/messages', middleware: [requireAuth], router: createMessageRoutes(db, wsService, auth) },
    { prefix: '/memory', middleware: [requireAuth], router: createMemoryRoutes(db, auth) },
    { prefix: '/skills', middleware: [requireAuth], router: createSkillRoutes(db, auth) },
    { prefix: '/openmythos', middleware: [requireAuth], router: createOpenMythosRoutes(db, auth) },
    { prefix: '/gym', middleware: [requireAuth], router: createGymRoutes(db, auth) },
    { prefix: '/runtime-governance', middleware: [requireAuth], router: createRuntimeGovernanceRoutes(db, auth) },
    { prefix: '/cognitive', middleware: [requireAuth], router: createCognitiveRoutes(db, auth) },
    { prefix: '/self-modification', middleware: [requireAuth], router: createSelfModificationRoutes(db, auth) },
    { prefix: '/fleet', middleware: [requireAuth], router: createFleetRoutes(db, auth) },
    { prefix: '/models', middleware: [requireAuth], router: createMultiModelRoutes(db, auth) },
    { prefix: '/compliance', middleware: [requireAuth], router: createComplianceRoutes(db, auth) },
    { prefix: '/retirement', middleware: [requireAuth], router: createRetirementRoutes(db, auth) },
    { prefix: '/red-team', middleware: [requireAuth], router: createRedTeamRoutes(db, auth) },
    { prefix: '/platform', middleware: [requireAuth], router: createPlatformRoutes(db, auth) },
    { prefix: '/advanced', middleware: [requireAuth], router: createAdvancedRoutes(db, auth) },
    { prefix: '/health', middleware: [], router: createHealthRoutes(db, auth) },
    { prefix: '/legal', middleware: [requireAuth], router: createLegalRoutes(db, auth) },
    { prefix: '/research', middleware: [requireAuth], router: createResearchRoutes(db, auth) },
    { prefix: '/canvas', middleware: [requireAuth], router: createCanvasRoutes(db, auth) },
    { prefix: '/telegram', middleware: [], router: createTelegramRoutes(db, auth) },
    { prefix: '/apex', middleware: [requireAuth], router: createApexRoutes(db, auth) },
    { prefix: '/swarm-v2', middleware: [requireAuth], router: createSwarmOrchestrationRoutes(db, auth) },
    { prefix: '/self-improve', middleware: [requireAuth], router: createSelfImprovementRoutes(db, auth) },
    { prefix: '/swarm-intel', middleware: [requireAuth], router: createSwarmIntelRoutes(db, auth) },
    { prefix: '/agi', middleware: [requireAuth], router: createAgiRoutes(db, auth) },
    { prefix: '/intelligence', middleware: [requireAuth], router: createIntelligenceRoutes(db, auth) },
    { prefix: '/meta', middleware: [requireAuth], router: createMetaOrchestrationRoutes(db, auth, metaOrchestration) },
  );

  for (const mount of mounts) {
    router.use(mount.prefix, ...mount.middleware, mount.router);
  }

  // Machine-readable API surface, derived from the mount table above.
  // express-rate-limit so CodeQL recognizes the limiter (same policy as /metrics).
  const openApiRateLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: false, legacyHeaders: false });
  let openApiSpec: Record<string, unknown> | null = null;
  router.get('/openapi.json', openApiRateLimiter, requireAuth, (_req, res) => {
    openApiSpec ??= buildOpenApiSpec(collectRoutes(mounts), { title: 'Djimitflo API', version: getAppVersion() });
    res.json(openApiSpec);
  });

  return router;
}

export function scanListeningPorts(): Array<{ address: string; port: number; pid: number | null; process: string; bind: string }> {
  if (process.platform === 'darwin') {
    const output = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 5_000 });
    return output.trim().split('\n').slice(1).flatMap((line) => {
      const columns = line.trim().split(/\s+/);
      const match = line.match(/TCP\s+(.+):(\d+)\s+\(LISTEN\)$/);
      if (!match) return [];
      const address = match[1];
      return [{
        address,
        port: Number(match[2]),
        pid: Number(columns[1]) || null,
        process: columns[0] || 'unknown',
        bind: address === '*' || address === '0.0.0.0' || address === '[::]' ? 'LAN' : 'Localhost',
      }];
    });
  }
  if (process.platform === 'linux') {
    const output = execFileSync('ss', ['-H', '-tlnp'], { encoding: 'utf8', timeout: 5_000 });
    return output.trim().split('\n').flatMap((line) => {
      const match = line.match(/\s(\S+):(\d+)\s+/);
      if (!match) return [];
      const processName = line.match(/users:\(\("([^"]+)"/)?.[1] || 'unknown';
      const address = match[1];
      return [{
        address,
        port: Number(match[2]),
        pid: Number(line.match(/pid=(\d+)/)?.[1]) || null,
        process: processName,
        bind: address === '*' || address === '0.0.0.0' || address === '[::]' ? 'LAN' : 'Localhost',
      }];
    });
  }
  throw new Error(`Listening-port discovery is unsupported on ${process.platform}`);
}
