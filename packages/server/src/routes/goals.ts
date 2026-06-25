import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { createError } from '../middleware/error-handler';
import { GoalBatchService } from '../services/goal-batch-service';
import { LoopService } from '../services/loop-service';

function mapLoopServiceError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'GOAL_NOT_FOUND') throw createError(404, 'Goal not found', 'GOAL_NOT_FOUND');
  if (message === 'GOAL_OBJECTIVE_REQUIRED') throw createError(400, 'objective is required', 'GOAL_OBJECTIVE_REQUIRED');
  if (message === 'GOAL_ACCEPTANCE_CRITERIA_REQUIRED') {
    throw createError(400, 'acceptance_criteria must contain at least one measurable criterion', 'GOAL_ACCEPTANCE_CRITERIA_REQUIRED');
  }
  if (message === 'GOAL_RISK_CLASS_INVALID') throw createError(400, 'risk_class is invalid', 'GOAL_RISK_CLASS_INVALID');
  if (message === 'GOAL_STATUS_INVALID') throw createError(400, 'status is invalid', 'GOAL_STATUS_INVALID');
  if (message === 'GOAL_BATCH_INVALID') throw createError(400, 'goal batch contains invalid items', 'GOAL_BATCH_INVALID');
  if (message === 'GOAL_BATCH_NOT_FOUND') throw createError(404, 'goal batch not found', 'GOAL_BATCH_NOT_FOUND');
  if (message === 'GOAL_BATCH_JSON_INVALID') throw createError(400, 'goal batch JSON is invalid', 'GOAL_BATCH_JSON_INVALID');
  if (message === 'GOAL_BATCH_PATH_FORBIDDEN') throw createError(403, 'goal batch path is outside the repository', 'GOAL_BATCH_PATH_FORBIDDEN');
  throw error;
}

export function createGoalRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const loopService = new LoopService(db);
  const goalBatchService = new GoalBatchService(db);

  router.get('/', requirePermission('read:evidence'), (_req, res, next) => {
    try {
      res.json({ goals: loopService.listGoals() });
    } catch (error) {
      next(error);
    }
  });

  router.post('/', requirePermission('create:task'), (req, res, next) => {
    try {
      const ownerId = (req as any).user?.sub;
      const goal = loopService.createGoal(req.body, ownerId);
      res.status(201).json(goal);
    } catch (error) {
      try {
        mapLoopServiceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/batch/preview', requirePermission('read:evidence'), (req, res, next) => {
    try {
      res.json(goalBatchService.preview(req.body || {}));
    } catch (error) {
      try {
        mapLoopServiceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/batch/apply', requirePermission('create:task'), (req, res, next) => {
    try {
      const ownerId = (req as any).user?.sub;
      res.status(201).json(goalBatchService.apply(req.body || {}, ownerId));
    } catch (error) {
      try {
        mapLoopServiceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.get('/:id', requirePermission('read:evidence'), (req, res, next) => {
    try {
      res.json(loopService.getGoal(req.params.id));
    } catch (error) {
      try {
        mapLoopServiceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.patch('/:id', requirePermission('create:task'), (req, res, next) => {
    try {
      res.json(loopService.updateGoal(req.params.id, req.body));
    } catch (error) {
      try {
        mapLoopServiceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/:id/decompose', requirePermission('create:task'), (req, res, next) => {
    try {
      res.json(loopService.decomposeGoal(req.params.id));
    } catch (error) {
      try {
        mapLoopServiceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  return router;
}
