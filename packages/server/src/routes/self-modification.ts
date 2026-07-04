/**
 * Self-Modification routes — autonomous code improvement with evidence gating.
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

  // POST /api/self-modification/analyze — analyze codebase for improvements
  router.post('/analyze', requirePermission('write:governance'), (__req, res) => {
    const opportunities = pipeline.analyze();
    res.json({ opportunitiesFound: opportunities.length, opportunities });
  });

  // POST /api/self-modification/plan — create plan for an opportunity
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

  // POST /api/self-modification/execute — execute a plan
  router.post('/execute', requirePermission('write:governance'), async (req, res) => {
    const { planId } = req.body;
    if (!planId) {
      res.status(400).json({ error: { message: 'planId is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    try {
      const result = await pipeline.executePlan(planId);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: { message: error instanceof Error ? error.message : String(error) } });
    }
  });

  return router;
}
