import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { AdversarialRedTeamService } from '../services/adversarial-red-team-service';
import { RuntimeGovernanceService } from '../services/runtime-governance-service';
import { createError } from '../middleware/error-handler';

function boundedLimit(value: unknown, fallback = 10): number {
  if (value === undefined) return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw createError(400, 'limit must be an integer between 1 and 500', 'VALIDATION_ERROR');
  }
  return limit;
}

export function createRedTeamRoutes(
  db: Database,
  auth?: AuthMiddleware,
  governance = new RuntimeGovernanceService(db),
): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const service = new AdversarialRedTeamService(db, governance);

  router.post('/assess', requirePermission('write:governance'), async (_req, res) => {
    const report = await service.runAssessment();
    res.json(report);
  });

  router.get('/latest', requirePermission('read:evidence'), (_req, res) => {
    const report = service.getLatestReport();
    res.json(report || { message: 'No assessment run yet' });
  });

  router.get('/history', requirePermission('read:evidence'), (req, res) => {
    const limit = boundedLimit(req.query.limit);
    res.json({ history: service.getHistory(limit) });
  });

  return router;
}
