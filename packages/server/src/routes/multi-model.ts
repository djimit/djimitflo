/**
 * Multi-Model Intelligence routes — capability-aware model routing.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { MultiModelIntelligence } from '../services/multi-model-intelligence';
import { createError } from '../middleware/error-handler';

function boundedLimit(value: unknown, fallback = 5): number {
  if (value === undefined) return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw createError(400, 'limit must be an integer between 1 and 100', 'VALIDATION_ERROR');
  }
  return limit;
}

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
    if (typeof modelId !== 'string' || !modelId.trim()
      || typeof modelName !== 'string' || !modelName.trim()
      || typeof provider !== 'string' || !provider.trim()
      || (costPerMtok !== undefined && (typeof costPerMtok !== 'number' || !Number.isFinite(costPerMtok) || costPerMtok < 0))
      || (capabilities !== undefined && (!Array.isArray(capabilities) || capabilities.some((capability) => {
        if (!capability || typeof capability !== 'object' || typeof capability.taskType !== 'string' || !capability.taskType.trim()) return true;
        return capability.successRate !== undefined
          && (typeof capability.successRate !== 'number' || !Number.isFinite(capability.successRate) || capability.successRate < 0 || capability.successRate > 1);
      })))) {
      res.status(400).json({ error: { message: 'modelId, modelName, provider and valid optional cost/capabilities are required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const model = service.registerModel({ modelId, modelName, provider, costPerMtok, capabilities });
    res.status(201).json(model);
  });

  // POST /api/models/route — route a task to the best model
  router.post('/route', requirePermission('read:evidence'), (req, res) => {
    const { taskType, minSuccessRate, maxCost, preferLowLatency } = req.body;
    if (typeof taskType !== 'string' || !taskType.trim()
      || (minSuccessRate !== undefined && (typeof minSuccessRate !== 'number' || !Number.isFinite(minSuccessRate) || minSuccessRate < 0 || minSuccessRate > 1))
      || (maxCost !== undefined && (typeof maxCost !== 'number' || !Number.isFinite(maxCost) || maxCost < 0))
      || (preferLowLatency !== undefined && typeof preferLowLatency !== 'boolean')) {
      res.status(400).json({ error: { message: 'taskType and valid optional routing constraints are required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const decision = service.routeTask({ taskType, minSuccessRate, maxCost, preferLowLatency });
    res.json(decision);
  });

  // POST /api/models/outcome — record execution outcome
  router.post('/outcome', requirePermission('write:swarm_action'), (req, res) => {
    const { modelId, taskType, success, score, latencyMs, costDollars } = req.body;
    if (typeof modelId !== 'string' || !modelId.trim()
      || typeof taskType !== 'string' || !taskType.trim()
      || typeof success !== 'boolean'
      || (score !== undefined && (typeof score !== 'number' || !Number.isFinite(score) || score < 0))
      || (latencyMs !== undefined && (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs) || latencyMs < 0))
      || (costDollars !== undefined && (typeof costDollars !== 'number' || !Number.isFinite(costDollars) || costDollars < 0))) {
      res.status(400).json({ error: { message: 'modelId, taskType, boolean success and valid optional metrics are required', code: 'VALIDATION_ERROR' } });
      return;
    }
    service.recordOutcome({ modelId, taskType, success, score, latencyMs, costDollars });
    res.json({ recorded: true });
  });

  // GET /api/models/best/:taskType — best models for a task type
  router.get('/best/:taskType', requirePermission('read:evidence'), (req, res) => {
    const limit = boundedLimit(req.query.limit);
    res.json({ models: service.getBestModels(req.params.taskType, limit) });
  });

  return router;
}
