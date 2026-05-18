import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { CommandRiskClassifier } from '../services/command-risk-classifier';

export function createRiskRoutes(_db: Database): Router {
  const router = Router();
  const classifier = new CommandRiskClassifier();

  router.post('/command', (req, res, next) => {
    try {
      const assessment = classifier.classify(req.body.command || '', {
        workspacePath: req.body.workspacePath,
      });
      res.json({ assessment });
    } catch (error) {
      next(error);
    }
  });

  router.post('/task', (req, res, next) => {
    try {
      const assessment = classifier.assessTask(req.body.task, req.body.executorKind || 'opencode', req.body.workspacePath);
      res.json({ assessment });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
