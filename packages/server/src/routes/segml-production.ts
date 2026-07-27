/**
 * SEGML Production routes — training-data export and Ollama model packaging.
 *
 * Evaluation and promotion use /api/openmythos and
 * /api/governance-feedback; this router does not maintain a competing scorer.
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

  // POST /api/segml/production/train — package an Ollama model
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
