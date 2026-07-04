import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { AdversarialRedTeamService } from '../services/adversarial-red-team-service';

export function createRedTeamRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const service = new AdversarialRedTeamService(db);

  router.post('/assess', requirePermission('write:governance'), async (_req, res) => {
    const report = await service.runAssessment();
    res.json(report);
  });

  router.get('/latest', requirePermission('read:evidence'), (_req, res) => {
    const report = service.getLatestReport();
    res.json(report || { message: 'No assessment run yet' });
  });

  router.get('/history', requirePermission('read:evidence'), (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : 10;
    res.json({ history: service.getHistory(limit) });
  });

  return router;
}
