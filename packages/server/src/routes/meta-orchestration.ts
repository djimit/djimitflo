/**
 * Meta-orchestration routes — self-driving control plane visibility and control.
 */

import { Router } from 'express';
import type { MetaOrchestrationService } from '../services/meta-orchestration-service';

export function createMetaOrchestrationRoutes(
  _db: unknown,
  _auth: unknown,
  metaOrchestration?: MetaOrchestrationService,
): Router {
  const router = Router();

  const notEnabled = (_req: any, res: any) => {
    if (res && typeof res.json === 'function') return res.json({ enabled: false });
  };

  // GET /api/meta/stats
  router.get('/stats', (req, res) => {
    if (!metaOrchestration) return notEnabled(req, res);
    res.json({ enabled: true, ...metaOrchestration.getStats() });
  });

  // GET /api/meta/tuning/:goalType
  router.get('/tuning/:goalType', (req, res) => {
    if (!metaOrchestration) return notEnabled(req, res);
    res.json(metaOrchestration.getLoopTuning(req.params.goalType));
  });

  // GET /api/meta/tuning-history
  router.get('/tuning-history', (req, res) => {
    if (!metaOrchestration) return notEnabled(req, res);
    const goalType = req.query.goalType as string | undefined;
    const limit = Number(req.query.limit) || 20;
    res.json(metaOrchestration.getTuningHistory(goalType, limit));
  });

  // GET /api/meta/routing/:taskType
  router.get('/routing/:taskType', (req, res) => {
    if (!metaOrchestration) return notEnabled(req, res);
    res.json(metaOrchestration.getRoutingOptimization(req.params.taskType));
  });

  // GET /api/meta/strategy/:goalType
  router.get('/strategy/:goalType', (req, res) => {
    if (!metaOrchestration) return notEnabled(req, res);
    res.json(metaOrchestration.getStrategyRecommendation(req.params.goalType));
  });

  // POST /api/meta/predict
  router.post('/predict', (req, res) => {
    if (!metaOrchestration) return notEnabled(req, res);
    res.json(metaOrchestration.predictFailure(req.body));
  });

  return router;
}
