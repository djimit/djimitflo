import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
import { CapabilityRegistry } from '../services/capability-registry';

export function createCapabilityRoutes(db: Database.Database) {
  const router = Router();
  const registry = new CapabilityRegistry(db);

  // POST /capabilities - Create new capability
  router.post('/', (req: Request, res: Response) => {
    try {
      const { kind, name, version, risk_ceiling, contract, allowed_actions, forbidden_actions } = req.body;

      const userId = (req as any).user?.id || 'system';

      const capability = registry.create(
        { kind, name, version, risk_ceiling, contract, allowed_actions, forbidden_actions },
        userId
      );

      res.status(201).json(capability);
    } catch (err) {
      const error = err as Error;
      res.status(400).json({ error: error.message });
    }
  });

  // GET /capabilities - List capabilities with optional filters
  router.get('/', (req: Request, res: Response) => {
    try {
      const { kind, status, owner, name } = req.query;
      const capabilities = registry.list({
        kind: kind as string | undefined,
        status: status as string | undefined,
        owner: owner as string | undefined,
        name: name as string | undefined,
      });

      res.json({ capabilities });
    } catch (err) {
      const error = err as Error;
      res.status(500).json({ error: error.message });
    }
  });

  // GET /capabilities/:id - Get capability by ID
  router.get('/:id', (req: Request, res: Response): void => {
    try {
      const capability = registry.getById(req.params.id);
      if (!capability) {
        res.status(404).json({ error: 'CAPABILITY_NOT_FOUND' });
        return;
      }

      res.json(capability);
    } catch (err) {
      const error = err as Error;
      res.status(500).json({ error: error.message });
    }
  });

  // PATCH /capabilities/:id/promote - Promote capability status
  router.patch('/:id/promote', (req: Request, res: Response) => {
    try {
      const { to_status } = req.body;
      const userId = (req as any).user?.id || 'system';

      const capability = registry.promote(req.params.id, to_status, userId);
      res.json(capability);
    } catch (err) {
      const error = err as Error;
      res.status(400).json({ error: error.message });
    }
  });

  // PATCH /capabilities/:id/eval - Update eval score
  router.patch('/:id/eval', (req: Request, res: Response) => {
    try {
      const { eval_score, evidence_refs } = req.body;

      const capability = registry.updateEvalScore(req.params.id, eval_score, evidence_refs || []);
      res.json(capability);
    } catch (err) {
      const error = err as Error;
      res.status(400).json({ error: error.message });
    }
  });

  // POST /capabilities/:id/execute - Record execution
  router.post('/:id/execute', (req: Request, res: Response) => {
    try {
      const { tokens_used } = req.body;
      registry.recordExecution(req.params.id, tokens_used || 0);

      res.json({ status: 'recorded' });
    } catch (err) {
      const error = err as Error;
      res.status(400).json({ error: error.message });
    }
  });

  // GET /capabilities/:id/can-route - Check if capability can route workers
  router.get('/:id/can-route', (req: Request, res: Response) => {
    try {
      const canRoute = registry.canRoute(req.params.id);
      res.json({ can_route: canRoute });
    } catch (err) {
      const error = err as Error;
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
