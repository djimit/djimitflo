import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';

export function createLearningRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  router.get('/', requirePermission('view:dashboard'), (_req, res, next) => {
    try {
      const rows = db.prepare('SELECT * FROM swarm_learning ORDER BY created_at DESC LIMIT 100').all();
      res.json({ learnings: rows });
    } catch (err) { next(err); }
  });

  return router;
}
