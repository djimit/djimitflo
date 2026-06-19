/**
 * API routes aggregator
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { createTaskRoutes } from './tasks';
import { createAgentRoutes } from './agents';
import { createMCPRoutes } from './mcp';
import { createApprovalRoutes } from './approvals';
import type { ExecutionEngine } from '../execution/execution-engine';
import { createPolicyRoutes } from './policies';
import { createRiskRoutes } from './risk';
import { createEvidenceRoutes } from './evidence';
import { createObservabilityRoutes } from './observability';
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
import { createMemoryRoutes } from './memory';
import { createSkillRoutes } from './skills';
import { createLearningRoutes } from './learning';
import { getAppVersion } from '../utils/version';
import { createGoalRoutes } from './goals';
import { createLoopRoutes } from './loops';
import { createWorkItemRoutes } from './work-items';
import { createSwarmRoutes } from './swarms';
import { createSpawnRoutes } from './spawns';
import type { WebSocketService } from '../services/websocket-service';

export function createRoutes(
  db: Database,
  executionEngine?: ExecutionEngine,
  authService?: AuthService,
  auth?: AuthMiddleware,
  wsService?: WebSocketService
): Router {
  const router = Router();
  
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
  router.use('/mcp', requireAuth, createMCPRoutes(db, auth));
  router.use('/approvals', requireAuth, createApprovalRoutes(db, executionEngine, auth));
  router.use('/policies', requireAuth, createPolicyRoutes(db, auth));
  router.use('/risk', requireAuth, createRiskRoutes(db, auth));
  router.use('/evidence', requireAuth, createEvidenceRoutes(db, auth!));
  router.use('/observability', requireAuth, createObservabilityRoutes(db, auth!));
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
  router.use('/discussions', requireAuth, createDiscussionRoutes(db, auth));
  router.use('/usage', requireAuth, createUsageRoutes(db, auth));
  router.use('/learning', requireAuth, createLearningRoutes(db, auth));

  router.use('/backups', requireAuth, createBackupRoutes(db, auth!));
  router.use('/exports', requireAuth, createExportRoutes(db, auth!));
  router.use('/messages', requireAuth, createMessageRoutes(db, wsService, auth));
  router.use('/memory', requireAuth, createMemoryRoutes(db, auth));
  router.use('/skills', requireAuth, createSkillRoutes(db, auth));
  
  return router;
}
