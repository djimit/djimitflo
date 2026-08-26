import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { CognitivePlatformOrchestrator } from '../services/cognitive-platform-orchestrator';
import { RuntimeGovernanceService } from '../services/runtime-governance-service';

export function createPlatformRoutes(
  db: Database,
  auth?: AuthMiddleware,
  governance = new RuntimeGovernanceService(db),
): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const orchestrator = new CognitivePlatformOrchestrator(db, governance);
  orchestrator.start();

  router.get('/status', requirePermission('read:evidence'), (_req, res) => {
    res.json(orchestrator.getPlatformStatus());
  });

  router.post('/cycle', requirePermission('write:governance'), async (_req, res) => {
    const result = await orchestrator.runCognitiveCycle();
    res.json(result);
  });

  return router;
}
