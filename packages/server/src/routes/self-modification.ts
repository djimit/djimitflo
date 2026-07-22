/**
 * Self-Modification routes — autonomous code improvement with evidence gating.
 *
 * SECURITY: Execute route is disabled. Self-modification in the source checkout
 * is a hard no-go without disposable worktree, independent approvals, and
 * sandboxed execution. See security review finding #2.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { SelfModificationPipeline } from '../services/self-modification-pipeline';

export function createSelfModificationRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const pipeline = new SelfModificationPipeline(db);

  // GET /api/self-modification/status — overall status
  router.get('/status', requirePermission('read:evidence'), (__req, res) => {
    res.json(pipeline.getStatus());
  });

  // POST /api/self-modification/analyze — analyze codebase for improvements (read-only)
  router.post('/analyze', requirePermission('write:governance'), (__req, res) => {
    const opportunities = pipeline.analyze();
    res.json({ opportunitiesFound: opportunities.length, opportunities });
  });

  // POST /api/self-modification/plan — create plan for an opportunity (read-only)
  router.post('/plan', requirePermission('write:governance'), (req, res) => {
    const { opportunityId } = req.body;
    if (!opportunityId) {
      res.status(400).json({ error: { message: 'opportunityId is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const plan = pipeline.createPlan(opportunityId);
    if (!plan) {
      res.status(404).json({ error: { message: 'Opportunity not found', code: 'NOT_FOUND' } });
      return;
    }
    res.status(201).json(plan);
  });

  // POST /api/self-modification/execute — DISABLED
  // Re-enabling requires: disposable worktree, RsiSafetyGuard coupling,
  // maker-checker-approver separation, and sandboxed execution.
  router.post('/execute', requirePermission('write:governance'), (_req, res) => {
    res.status(451).json({
      error: {
        message: 'Self-modification execute is disabled for security. Use analyze+plan to generate a PR manually.',
        code: 'SELF_MODIFICATION_DISABLED',
        details: 'Direct code mutation via API is blocked. Create a plan, apply changes in an isolated worktree, and submit via PR with independent review.',
      },
    });
  });

  return router;
}
