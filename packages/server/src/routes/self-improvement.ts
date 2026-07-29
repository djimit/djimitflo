/**
 * Self-improvement documentation diagnostics.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { AutonomousDocsService } from '../services/autonomous-docs-service';

export function createSelfImprovementRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  const docs = new AutonomousDocsService(db);

  // GET /api/self-improve/docs/scan — scan for undocumented APIs
  router.get('/docs/scan', requirePermission('read:evidence'), (_req, res) => {
    const gaps = docs.scan();
    res.json({ gaps, count: gaps.length });
  });

  // GET /api/self-improve/docs/stats — documentation coverage
  router.get('/docs/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(docs.getStats());
  });

  return router;
}
