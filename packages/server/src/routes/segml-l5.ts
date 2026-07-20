/**
 * SEGML Level 5 routes — Self-Referential Architecture (Gödel Machine).
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { SegmlLevel5Bridge } from '../services/segml-level5-bridge';

export function createSegmlL5Routes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requireAuth = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  // POST /api/segml/l5/self-improve — run self-improvement cycle
  router.post('/self-improve', requireAuth('write:governance'), (_req, res, next) => {
    try {
      const bridge = new SegmlLevel5Bridge(db);
      const steps = bridge.runSelfImprovementCycle();
      res.json({ generation: bridge.getStatus().generation, steps, applied: steps.length });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/segml/l5/revert/:id — revert a modification
  router.post('/revert/:id', requireAuth('write:governance'), (req, res, next) => {
    try {
      const bridge = new SegmlLevel5Bridge(db);
      const reverted = bridge.revertModification(req.params.id);
      res.json({ reverted });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/segml/l5/status — self-referential status
  router.get('/status', requireAuth('read:evidence'), (_req, res, next) => {
    try {
      const bridge = new SegmlLevel5Bridge(db);
      res.json(bridge.getStatus());
    } catch (error) {
      next(error);
    }
  });

  return router;
}
