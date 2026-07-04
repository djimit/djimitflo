import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { AgentRetirementService } from '../services/agent-retirement-service';

export function createRetirementRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const service = new AgentRetirementService(db);

  router.get('/plan/:agentId', requirePermission('read:evidence'), (req, res) => {
    res.json(service.planRetirement(req.params.agentId));
  });

  router.post('/retire/:agentId', requirePermission('write:governance'), async (req, res) => {
    const { reason } = req.body;
    if (!reason?.trim()) {
      res.status(400).json({ error: { message: 'reason is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const plan = await service.retireAgent(req.params.agentId, reason);
    res.json(plan);
  });

  router.get('/status/:agentId', requirePermission('read:evidence'), (req, res) => {
    res.json(service.getRetirementStatus(req.params.agentId));
  });

  router.get('/list', requirePermission('read:evidence'), (_req, res) => {
    res.json({ retired: service.listRetiredAgents() });
  });

  return router;
}
