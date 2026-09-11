/**
 * Meta-orchestration routes — self-driving control plane visibility and control.
 */

import { Router } from 'express';
import type { MetaOrchestrationService } from '../services/meta-orchestration-service';
import type { AuthMiddleware } from '../middleware/auth';
import { createError } from '../middleware/error-handler';

function boundedLimit(value: unknown, fallback = 20): number {
  if (value === undefined) return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw createError(400, 'limit must be an integer between 1 and 500', 'VALIDATION_ERROR');
  }
  return limit;
}

export function createMetaOrchestrationRoutes(
  _db: unknown,
  _auth: unknown,
  metaOrchestration?: MetaOrchestrationService,
): Router {
  const router = Router();
  const requireGovernanceWrite = typeof (_auth as Partial<AuthMiddleware>)?.requirePermission === 'function'
    ? (_auth as AuthMiddleware).requirePermission('write:governance')
    : (_req: any, _res: any, next: any) => next();
  const requireEvidenceRead = typeof (_auth as Partial<AuthMiddleware>)?.requirePermission === 'function'
    ? (_auth as AuthMiddleware).requirePermission('read:evidence')
    : (_req: any, _res: any, next: any) => next();

  const notEnabled = (_req: any, res: any) => {
    if (res && typeof res.json === 'function') return res.json({ enabled: false });
  };

  // GET /api/meta/stats
  router.get('/stats', requireEvidenceRead, (req, res) => {
    if (!metaOrchestration) return notEnabled(req, res);
    res.json({ enabled: true, ...metaOrchestration.getStats() });
  });

  // GET /api/meta/tuning/:goalType
  router.get('/tuning/:goalType', requireEvidenceRead, (req, res) => {
    if (!metaOrchestration) return notEnabled(req, res);
    res.json(metaOrchestration.getLoopTuning(req.params.goalType));
  });

  // GET /api/meta/tuning-history
  router.get('/tuning-history', requireEvidenceRead, (req, res) => {
    if (!metaOrchestration) return notEnabled(req, res);
    const goalType = req.query.goalType as string | undefined;
    const limit = boundedLimit(req.query.limit);
    res.json(metaOrchestration.getTuningHistory(goalType, limit));
  });

  router.post('/tuning/run', requireGovernanceWrite, async (req, res) => {
    if (!metaOrchestration) return notEnabled(req, res);
    res.json(await metaOrchestration.runAutoTuning());
  });

  // GET /api/meta/routing/:taskType
  router.get('/routing/:taskType', requireEvidenceRead, (req, res) => {
    if (!metaOrchestration) return notEnabled(req, res);
    res.json(metaOrchestration.getRoutingOptimization(req.params.taskType));
  });

  // GET /api/meta/strategy/:goalType
  router.get('/strategy/:goalType', requireEvidenceRead, (req, res) => {
    if (!metaOrchestration) return notEnabled(req, res);
    res.json(metaOrchestration.getStrategyRecommendation(req.params.goalType));
  });

  // POST /api/meta/predict
  router.post('/predict', requireEvidenceRead, (req, res) => {
    if (!metaOrchestration) return notEnabled(req, res);
    const task = req.body;
    if (!task || typeof task !== 'object' || Array.isArray(task)
      || typeof task.title !== 'string' || !task.title.trim()
      || typeof task.description !== 'string' || !task.description.trim()
      || !Array.isArray(task.tags)) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'title, description and tags are required' } });
      return;
    }
    res.json(metaOrchestration.predictFailure(req.body));
  });

  return router;
}
