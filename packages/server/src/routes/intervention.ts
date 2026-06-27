import { Router, Request, Response, NextFunction } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { LoopService } from '../services/loop-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { OperatorInterventionService } from '../services/operator-intervention';

export function createInterventionRoutes(db: Database, auth: AuthMiddleware): Router {
  const router = Router();
  const requireAdmin = auth.requirePermission('manage:config');
  const loops = new LoopService(db);
  const intelligence = new SwarmIntelligenceService(db);
  const intervention = new OperatorInterventionService(db, loops, intelligence);

  // G22: POST /api/intervention/:goalId/pause
  router.post('/:goalId/pause', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await intervention.pauseGoal(req.params.goalId);
      res.json(result);
    } catch (error) { next(error); }
  });

  // G22: POST /api/intervention/:goalId/resume
  router.post('/:goalId/resume', requireAdmin, (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = intervention.resumeGoal(req.params.goalId);
      res.json(result);
    } catch (error) { next(error); }
  });

  // G22: POST /api/intervention/:goalId/inject
  router.post('/:goalId/inject', requireAdmin, (req: Request, res: Response, next: NextFunction) => {
    try {
      const { predicate, subject_ref, confidence, evidence } = req.body;
      const result = intervention.injectKnowledge(req.params.goalId, { predicate, subject_ref, confidence, evidence });
      res.json(result);
    } catch (error) { next(error); }
  });

  // G22: POST /api/intervention/:goalId/override
  router.post('/:goalId/override', requireAdmin, (req: Request, res: Response, next: NextFunction) => {
    try {
      const { gate, decision, reason } = req.body;
      const result = intervention.overrideGate(req.params.goalId, gate, decision, reason);
      res.json(result);
    } catch (error) { next(error); }
  });

  return router;
}
