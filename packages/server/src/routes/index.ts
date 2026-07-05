/**
 * API routes aggregator
 */

import { Router } from 'express';
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
import { limitBodySize } from '../middleware/input-validation';
import type { WebSocketService } from '../services/websocket-service';

export function createRoutes(
  db: Database,
  executionEngine?: ExecutionEngine,
  authService?: AuthService,
  auth?: AuthMiddleware,
  wsService?: WebSocketService
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

  // Auth routes (public + protected)
  router.use('/auth', createAuthRoutes(authService!, auth!, auditService));

  // Protected routes
  router.use('/tasks', requireAuth, createTaskRoutes(db, executionEngine, auth));
  router.use('/agents', requireAuth, createAgentRoutes(db, auth));
  router.use('/catalog', requireAuth, createCatalogRoutes(db, auth));
  router.use('/mcp', requireAuth, createMCPRoutes(db, auth));
  router.use('/approvals', requireAuth, createApprovalRoutes(db, executionEngine, auth));
  router.use('/policies', requireAuth, createPolicyRoutes(db, auth));
  router.use('/risk', requireAuth, createRiskRoutes(db, auth));
  router.use('/evidence', requireAuth, createEvidenceRoutes(db, auth!));
  router.use('/observability', requireAuth, createObservabilityRoutes(db, auth!));

  // G15: knowledge bus HTTP endpoints (federation transport scaffold)
  router.use('/knowledge', requireAuth, createKnowledgeRoutes(auth!));

  // G26: federation protocol endpoints (peer discovery, claim sharing, work distribution)
  router.use('/federation', requireAuth, createFederationRoutes(db, auth!));

  // D2: workstation URLs — live ss -tlnp scan
  router.get('/workstation/urls', requireAuth, (_req: any, res: any) => {
    try {
      const { execFileSync } = require('child_process');
      const output = execFileSync('ss', ['-tlnp'], { encoding: 'utf8', timeout: 5000 });
      const lines = output.trim().split('\n').slice(1); // skip header
      const ports = lines.map((line: string) => {
        const match = line.match(/\S+\s+\S+\s+\S+\s+([\d.]+):(\d+)\s+/);
        const pidMatch = line.match(/pid=(\d+)/);
        const usersMatch = line.match(/users:\(\("([^"]+)"/);
        if (match) {
          return {
            address: match[1],
            port: parseInt(match[2]),
            pid: pidMatch ? parseInt(pidMatch[1]) : null,
            process: usersMatch ? usersMatch[1] : 'unknown',
            bind: match[1] === '0.0.0.0' || match[1] === '*' ? 'LAN' : 'Localhost',
          };
        }
        return null;
      }).filter(Boolean);
      res.json({ ports });
    } catch (error) {
      res.status(500).json({ error: 'Failed to scan workstation ports' });
    }
  });

  // G22: operator intervention (pause/resume/inject/override)
  router.use('/intervention', requireAuth, createInterventionRoutes(db, auth!));
  router.use('/goals', requireAuth, createGoalRoutes(db, auth));
  router.use('/loops', requireAuth, createLoopRoutes(db, auth));
  router.use('/work-items', requireAuth, createWorkItemRoutes(db, auth));
  // Nested spawn control: mount the specific /swarms/spawns path BEFORE the
  // generic /swarms requireAuth mount so children can reach it with a spawn token.
  router.use('/swarms/spawns', requireAuthOrSpawnToken, createSpawnRoutes(db, auth, wsService));
  router.use('/swarms', requireAuth, createSwarmRoutes(db, auth, wsService));
  router.use('/repositories', requireAuth, createRepositoryRoutes(db, auth));
  router.use('/', requireAuth, createDiffRoutes(db, auth));
  router.use('/audit', requireAuth, createAuditRoutes(db, auditService, auth));
  router.use('/discussions', requireAuth, createDiscussionRoutes(db, auth, wsService));
  router.use('/usage', requireAuth, createUsageRoutes(db, auth));
  router.use('/learning', requireAuth, createLearningRoutes(db, auth));

  router.use('/backups', requireAuth, createBackupRoutes(db, auth!));
  router.use('/exports', requireAuth, createExportRoutes(db, auth!));
  router.use('/messages', requireAuth, createMessageRoutes(db, wsService, auth));
  router.use('/memory', requireAuth, createMemoryRoutes(db, auth));
  router.use('/skills', requireAuth, createSkillRoutes(db, auth));
  router.use('/openmythos', requireAuth, createOpenMythosRoutes(db, auth));
  router.use('/gym', requireAuth, createGymRoutes(db, auth));
  router.use('/runtime-governance', requireAuth, createRuntimeGovernanceRoutes(db, auth));
  router.use('/cognitive', requireAuth, createCognitiveRoutes(db, auth));
  router.use('/self-modification', requireAuth, createSelfModificationRoutes(db, auth));
  router.use('/fleet', requireAuth, createFleetRoutes(db, auth));
  router.use('/models', requireAuth, createMultiModelRoutes(db, auth));
  router.use('/compliance', requireAuth, createComplianceRoutes(db, auth));
  router.use('/retirement', requireAuth, createRetirementRoutes(db, auth));
  router.use('/red-team', requireAuth, createRedTeamRoutes(db, auth));
  router.use('/platform', requireAuth, createPlatformRoutes(db, auth));
  router.use('/advanced', requireAuth, createAdvancedRoutes(db, auth));
  router.use('/health', createHealthRoutes(db, auth));
  router.use('/legal', requireAuth, createLegalRoutes(db, auth));
  router.use('/research', requireAuth, createResearchRoutes(db, auth));
  router.use('/canvas', requireAuth, createCanvasRoutes(db, auth));
  router.use('/telegram', createTelegramRoutes(db));
  router.use('/apex', requireAuth, createApexRoutes(db, auth));
  router.use('/swarm-v2', requireAuth, createSwarmOrchestrationRoutes(db, auth));
  router.use('/self-improve', requireAuth, createSelfImprovementRoutes(db, auth));
  router.use('/swarm-intel', requireAuth, createSwarmIntelRoutes(db, auth));
  router.use('/agi', requireAuth, createAgiRoutes(db, auth));
  router.use('/intelligence', requireAuth, createIntelligenceRoutes(db, auth));

  return router;
}
