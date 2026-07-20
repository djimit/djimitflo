/**
 * SEGML Fine-Tuning routes — Level 2: Foundation Model Improvement.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { SegmlFinetuningBridge } from '../services/segml-finetuning-bridge';

export function createSegmlFinetuningRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requireAuth = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  // POST /api/segml/finetuning/generate — generate training data
  router.post('/generate', requireAuth('write:governance'), (req, res, next) => {
    try {
      const bridge = new SegmlFinetuningBridge(db);
      const dataset = bridge.generateTrainingData(req.body?.agentId);
      res.json({ datasetId: dataset.id, pairs: dataset.pairs.length, categories: dataset.categories });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/segml/finetuning/train — create fine-tuning job
  router.post('/train', requireAuth('write:governance'), (req, res, next) => {
    try {
      const bridge = new SegmlFinetuningBridge(db);
      const { datasetId, model } = req.body;
      if (!datasetId || !model) {
        res.status(400).json({ error: 'datasetId and model required' });
        return;
      }
      const job = bridge.createFinetuningJob(datasetId, model);
      res.json(job);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/segml/finetuning/ab-test — run A/B test
  router.post('/ab-test', requireAuth('write:governance'), (req, res, next) => {
    try {
      const bridge = new SegmlFinetuningBridge(db);
      const { datasetId, baselineModel, finetunedModel } = req.body;
      if (!datasetId || !baselineModel || !finetunedModel) {
        res.status(400).json({ error: 'datasetId, baselineModel, finetunedModel required' });
        return;
      }
      const result = bridge.runABTest(datasetId, baselineModel, finetunedModel);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/segml/finetuning/status — fine-tuning status
  router.get('/status', requireAuth('read:evidence'), (_req, res, next) => {
    try {
      const bridge = new SegmlFinetuningBridge(db);
      res.json(bridge.getStatus());
    } catch (error) {
      next(error);
    }
  });

  return router;
}
