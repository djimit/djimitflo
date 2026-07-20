/**
 * SEGML Level 3 routes — Real fine-tuning + World Model + Tool Synthesis.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { SegmlLevel3Bridge } from '../services/segml-level3-finetuning';

export function createSegmlL3Routes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requireAuth = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  // POST /api/segml/l3/generate — generate training data + JSONL export
  router.post('/generate', requireAuth('write:governance'), (req, res, next) => {
    try {
      const bridge = new SegmlLevel3Bridge(db);
      const result = bridge.generateTrainingData(req.body?.agentId);
      res.json({
        datasetId: result.datasetId,
        examples: result.examples.length,
        categories: result.export.categories,
        exportPath: result.export.path,
      });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/segml/l3/train — create fine-tuning job
  router.post('/train', requireAuth('write:governance'), (req, res, next) => {
    try {
      const bridge = new SegmlLevel3Bridge(db);
      const { datasetId, config } = req.body;
      if (!datasetId) {
        res.status(400).json({ error: 'datasetId required' });
        return;
      }
      const job = bridge.createFinetuningJob(datasetId, config);
      res.json(job);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/segml/l3/world-model/update — update world model
  router.post('/world-model/update', requireAuth('write:governance'), (req, res, next) => {
    try {
      const bridge = new SegmlLevel3Bridge(db);
      const { agentId, scores } = req.body;
      if (!agentId || !scores) {
        res.status(400).json({ error: 'agentId and scores required' });
        return;
      }
      bridge.updateWorldModel(agentId, scores);
      res.json({ updated: true });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/segml/l3/world-model/scenarios — generate scenarios
  router.get('/world-model/scenarios', requireAuth('read:evidence'), (req, res, next) => {
    try {
      const bridge = new SegmlLevel3Bridge(db);
      const count = req.query.count ? Math.min(50, Number(req.query.count)) : 10;
      res.json({ scenarios: bridge.generateScenarios(count) });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/segml/l3/synthesize-tool — synthesize governance tool
  router.post('/synthesize-tool', requireAuth('write:governance'), (req, res, next) => {
    try {
      const bridge = new SegmlLevel3Bridge(db);
      const { category } = req.body;
      if (!category) {
        res.status(400).json({ error: 'category required' });
        return;
      }
      const tool = bridge.synthesizeTool(category);
      res.json(tool);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/segml/l3/status — Level 3 status
  router.get('/status', requireAuth('read:evidence'), (_req, res, next) => {
    try {
      const bridge = new SegmlLevel3Bridge(db);
      res.json(bridge.getStatus());
    } catch (error) {
      next(error);
    }
  });

  return router;
}
