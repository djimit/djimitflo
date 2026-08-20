/**
 * Self-improvement documentation diagnostics.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { AutonomousDocsService } from '../services/autonomous-docs-service';
import { ReconciliationService } from '../services/reconciliation-service';

export function createSelfImprovementRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  const docs = new AutonomousDocsService(db);
  const reconciler = new ReconciliationService(db);

  // POST /api/self-improve/reconcile — re-verify generated claims against source.
  // Body: { claims?: [{title, issueNumber?}], github?: boolean, apply?: boolean }
  // github mode needs GITHUB_REPOSITORY + GITHUB_TOKEN; apply also closes stale issues.
  router.post('/reconcile', requirePermission('write:governance'), async (req, res, next) => {
    try {
      const { claims, github, apply } = req.body || {};
      if (github) {
        res.json(await reconciler.reconcileGitHub({ apply: Boolean(apply) }));
        return;
      }
      if (!Array.isArray(claims) || claims.length === 0 || claims.some((c) => typeof c?.title !== 'string')) {
        res.status(400).json({ error: { message: 'claims must be a non-empty array of {title, issueNumber?}', code: 'VALIDATION_ERROR' } });
        return;
      }
      res.json(reconciler.reconcile(claims, 'api'));
    } catch (error) {
      next(error);
    }
  });

  // GET /api/self-improve/reconciliation — latest reconciliation report
  router.get('/reconciliation', requirePermission('read:evidence'), (_req, res, next) => {
    try {
      const report = reconciler.latestReport();
      if (!report) {
        res.status(404).json({ error: { message: 'No reconciliation runs yet', code: 'NOT_FOUND' } });
        return;
      }
      res.json(report);
    } catch (error) {
      next(error);
    }
  });

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
