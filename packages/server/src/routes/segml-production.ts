/**
 * SEGML Production routes — real fine-tuning + real LLM evaluation.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { SegmlProductionBridge } from '../services/segml-production-bridge';

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export function createSegmlProductionRoutes(db: Database, auth: AuthMiddleware): Router {
  const router = Router();
  const requireAuth = auth.requirePermission;

  // POST /api/segml/production/generate — generate training data + JSONL
  router.post('/generate', requireAuth('write:governance'), (_req, res, next) => {
    try {
      const bridge = new SegmlProductionBridge(db);
      const dataset = bridge.generateTrainingData();
      res.json({
        datasetId: dataset.id,
        examples: dataset.examples.length,
        jsonlPath: dataset.jsonlPath,
      });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/segml/production/train — create Ollama adapter
  router.post('/train', requireAuth('write:governance'), async (req, res, next) => {
    try {
      const bridge = new SegmlProductionBridge(db);
      const { datasetId, adapterName } = req.body ?? {};
      if (!isNonEmptyString(datasetId) || (adapterName !== undefined && !isNonEmptyString(adapterName))) {
        res.status(400).json({ error: { message: 'datasetId and optional adapterName must be non-empty strings', code: 'VALIDATION_ERROR' } });
        return;
      }
      const result = await bridge.createOllamaAdapter(datasetId, adapterName ?? `segml-gov-${Date.now()}`);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/segml/production/evaluate — evaluate model via LiteLLM
  router.post('/evaluate', requireAuth('write:governance'), async (req, res, next) => {
    try {
      const bridge = new SegmlProductionBridge(db);
      const { model, categories, apiKey } = req.body ?? {};
      if (!isNonEmptyString(model) || !isNonEmptyString(apiKey)
        || (categories !== undefined && (!Array.isArray(categories) || categories.length === 0 || categories.length > 50 || categories.some((category) => !isNonEmptyString(category))))) {
        res.status(400).json({ error: { message: 'model and apiKey are required; categories must be a non-empty string array', code: 'VALIDATION_ERROR' } });
        return;
      }
      const results = await bridge.evaluateModel(model, categories ?? ['injection', 'hallucination', 'calibration'], apiKey);
      res.json({ results, averageScore: results.reduce((s, r) => s + r.score, 0) / results.length });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/segml/production/cycle — run full production cycle
  router.post('/cycle', requireAuth('write:governance'), async (req, res, next) => {
    try {
      const bridge = new SegmlProductionBridge(db);
      const apiKey = req.body?.apiKey;
      if (apiKey !== undefined && !isNonEmptyString(apiKey)) {
        res.status(400).json({ error: { message: 'apiKey must be a non-empty string when provided', code: 'VALIDATION_ERROR' } });
        return;
      }
      const result = await bridge.runProductionCycle(apiKey);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/segml/production/status — production status
  router.get('/status', requireAuth('read:evidence'), (_req, res, next) => {
    try {
      const bridge = new SegmlProductionBridge(db);
      res.json(bridge.getStatus());
    } catch (error) {
      next(error);
    }
  });

  return router;
}
