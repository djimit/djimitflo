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
import type { AuthMiddleware } from '../middleware/auth';
import { createBackupRoutes } from './backup';
import { getAppVersion } from '../utils/version';

export function createRoutes(db: Database, executionEngine?: ExecutionEngine, authService?: AuthService, auth?: AuthMiddleware): Router {
  const router = Router();
  
  if (!authService || !auth) {
    console.warn('WARNING: Running without authentication. All routes are unprotected.');
  }

  const requireAuth = auth?.requireAuth ?? ((_req: any, _res: any, next: any) => next());

  // API version (public)
  router.get('/version', (_req, res) => {
    res.json({
      version: getAppVersion(),
      name: 'Djimitflo API',
    });
  });

  // Auth routes (public + protected)
  router.use('/auth', createAuthRoutes(authService!, auth!));

  // Protected routes
  router.use('/tasks', requireAuth, createTaskRoutes(db, executionEngine, auth));
  router.use('/agents', requireAuth, createAgentRoutes(db));
  router.use('/mcp', requireAuth, createMCPRoutes(db, auth));
  router.use('/approvals', requireAuth, createApprovalRoutes(db, executionEngine, auth));
  router.use('/policies', requireAuth, createPolicyRoutes(db, auth));
  router.use('/risk', requireAuth, createRiskRoutes(db, auth));
  router.use('/evidence', requireAuth, createEvidenceRoutes(db));
  router.use('/observability', requireAuth, createObservabilityRoutes(db));
  router.use('/repositories', requireAuth, createRepositoryRoutes(db, auth));
  router.use('/', requireAuth, createDiffRoutes(db));
  router.use('/backups', requireAuth, createBackupRoutes(db, auth!));
  
  return router;
}
