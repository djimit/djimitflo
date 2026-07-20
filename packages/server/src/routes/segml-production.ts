/**
 * SEGML Production routes — real fine-tuning + real LLM evaluation.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { SegmlProductionBridge } from '../services/segml-production-bridge';

export function createSegmlProductionRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requireAuth = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

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
      const { datasetId, adapterName } = req.body;
      if (!datasetId) { res.status(400).json({ error: 'datasetId required' }); return; }
      const result = await bridge.createOllamaAdapter(datasetId, adapterName || `segml-gov-${Date.now()}`);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/segml/production/evaluate — evaluate model via LiteLLM
  router.post('/evaluate', requireAuth('write:governance'), async (req, res, next) => {
    try {
      const bridge = new SegmlProductionBridge(db);
      const { model, categories, apiKey } = req.body;
      if (!model || !apiKey) { res.status(400).json({ error: 'model and apiKey required' }); return; }
      const results = await bridge.evaluateModel(model, categories || ['injection', 'hallucination', 'calibration'], apiKey);
      res.json({ results, averageScore: results.reduce((s, r) => s + r.score, 0) / results.length });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/segml/production/cycle — run full production cycle
  router.post('/cycle', requireAuth('write:governance'), async (req, res, next) => {
    try {
      const bridge = new SegmlProductionBridge(db);
      const result = await bridge.runProductionCycle(req.body?.apiKey);
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
