/**
 * Multi-Model Intelligence routes — capability-aware model routing.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { MultiModelIntelligence } from '../services/multi-model-intelligence';

export function createMultiModelRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const service = new MultiModelIntelligence(db);

  // GET /api/models/status — model registry status
  router.get('/status', requirePermission('read:evidence'), (_req, res) => {
    res.json(service.getStatus());
  });

  // POST /api/models/register — register a model
  router.post('/register', requirePermission('write:swarm_action'), (req, res) => {
    const { modelId, modelName, provider, costPerMtok, capabilities } = req.body;
    if (!modelId || !modelName) {
      res.status(400).json({ error: { message: 'modelId and modelName are required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const model = service.registerModel({ modelId, modelName, provider, costPerMtok, capabilities });
    res.status(201).json(model);
  });

  // POST /api/models/route — route a task to the best model
  router.post('/route', requirePermission('read:evidence'), (req, res) => {
    const { taskType, minSuccessRate, maxCost, preferLowLatency } = req.body;
    if (!taskType) {
      res.status(400).json({ error: { message: 'taskType is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const decision = service.routeTask({ taskType, minSuccessRate, maxCost, preferLowLatency });
    res.json(decision);
  });

  // POST /api/models/outcome — record execution outcome
  router.post('/outcome', requirePermission('write:swarm_action'), (req, res) => {
    const { modelId, taskType, success, score, latencyMs, costDollars } = req.body;
    if (!modelId || !taskType) {
      res.status(400).json({ error: { message: 'modelId and taskType are required', code: 'VALIDATION_ERROR' } });
      return;
    }
    service.recordOutcome({ modelId, taskType, success, score, latencyMs, costDollars });
    res.json({ recorded: true });
  });

  // GET /api/models/best/:taskType — best models for a task type
  router.get('/best/:taskType', requirePermission('read:evidence'), (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : 5;
    res.json({ models: service.getBestModels(req.params.taskType, limit) });
  });

  return router;
}
