import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { CommandRiskClassifier } from '../services/command-risk-classifier';
import type { AuthMiddleware } from '../middleware/auth';

export function createRiskRoutes(_db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const classifier = new CommandRiskClassifier();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  router.post('/command', requirePermission('execute:task'), (req, res, next) => {
    try {
      const assessment = classifier.classify(req.body.command || '', {
        workspacePath: req.body.workspacePath,
      });
      res.json({ assessment });
    } catch (error) {
      next(error);
    }
  });

  router.post('/task', requirePermission('execute:task'), (req, res, next) => {
    try {
      const assessment = classifier.assessTask(req.body.task, req.body.executorKind || 'opencode', req.body.workspacePath);
      res.json({ assessment });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
