/**
 * Self-improvement documentation diagnostics.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { AutonomousDocsService } from '../services/autonomous-docs-service';
import { ReconciliationService } from '../services/reconciliation-service';
import { SelfImprovementService, type ImprovementStatus } from '../services/self-improvement-service';
import { AutonomousGoalGenerator } from '../services/autonomous-goal-generator';
import { createError } from '../middleware/error-handler';

export function createSelfImprovementRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  const docs = new AutonomousDocsService(db);
  const reconciler = new ReconciliationService(db);
  const improvements = new SelfImprovementService(db);
  const goals = new AutonomousGoalGenerator(db);

  router.get('/proposals', requirePermission('read:evidence'), (req, res, next) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status as ImprovementStatus : undefined;
      if (status && !VALID_IMPROVEMENT_STATUSES.has(status)) throw createError(400, 'Invalid improvement status', 'VALIDATION_ERROR');
      res.json({ proposals: improvements.listImprovements(status, Number(req.query.limit) || 100) });
    } catch (error) { next(error); }
  });

  router.get('/proposals/:id', requirePermission('read:evidence'), (req, res, next) => {
    try { res.json(improvements.getImprovement(req.params.id)); }
    catch (error) { next(mapImprovementError(error)); }
  });

  router.post('/proposals/:id/approve', requirePermission('write:governance'), (req, res, next) => {
    try {
      const actor = req.user?.sub || req.user?.email;
      if (!actor) throw createError(401, 'Authentication required', 'AUTH_REQUIRED');
      const result = db.transaction(() => {
        improvements.approveImprovement(req.params.id, actor);
        return {
          goalCreated: goals.generateImprovement(req.params.id) === 1,
          proposal: improvements.getImprovement(req.params.id),
        };
      })();
      res.json(result);
    } catch (error) { next(mapImprovementError(error)); }
  });

  router.post('/proposals/:id/reject', requirePermission('write:governance'), (req, res, next) => {
    try { res.json({ proposal: improvements.rejectImprovement(req.params.id) }); }
    catch (error) { next(mapImprovementError(error)); }
  });

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

const VALID_IMPROVEMENT_STATUSES = new Set<ImprovementStatus>([
  'proposed', 'scheduled', 'executing', 'verified', 'evaluating', 'applied', 'rejected', 'no_change', 'regressed',
]);

function mapImprovementError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'SELF_IMPROVEMENT_NOT_FOUND') return createError(404, message, message);
  if (message.startsWith('SELF_IMPROVEMENT_')) return createError(409, message, message);
  return error instanceof Error ? error : new Error(message);
}
