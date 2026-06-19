import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { UsageService } from '../services/usage-service';
import { createError } from '../middleware/error-handler';

export function createUsageRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const usageService = new UsageService(db);
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  // GET /api/usage/tokens — query token usage
  router.get('/tokens', requirePermission('manage:config'), (req, res, next) => {
    try {
      const result = usageService.getTokenUsage({
        provider: req.query.provider as string,
        model: req.query.model as string,
        agent_id: req.query.agent_id as string,
        from: req.query.from as string,
        to: req.query.to as string,
        group_by: req.query.group_by as string,
      });
      res.json(result);
    } catch (err) { next(err); }
  });

  // POST /api/usage/tokens — batch insert from swarm outbox
  router.post('/tokens', requirePermission('manage:config'), (req, res, next) => {
    try {
      const { logs } = req.body;
      if (!Array.isArray(logs) || logs.length === 0) {
        throw createError(400, 'logs array required', 'INVALID_INPUT');
      }
      const inserted = usageService.batchInsertLogs(logs);
      res.status(201).json({ inserted, count: logs.length });
    } catch (err) {
      next(err);
    }
  });

  router.get('/costs', requirePermission('manage:config'), (req, res, next) => {
    try {
      const result = usageService.getCosts({
        provider: req.query.provider as string,
        from: req.query.from as string,
        to: req.query.to as string,
      });
      res.json(result);
    } catch (err) { next(err); }
  });

  router.get('/quotas', requirePermission('manage:config'), (_req, res, next) => {
    try {
      const quotas = usageService.getQuotas();
      res.json({ quotas });
    } catch (err) { next(err); }
  });

  router.get('/available-models', requirePermission('manage:config'), (_req, res, next) => {
    try {
      const models = usageService.getAvailableModels();
      res.json({ models });
    } catch (err) { next(err); }
  });

  router.get('/recent', requirePermission('manage:config'), (req, res, next) => {
    try {
      const limit = parseInt(req.query.limit as string, 10) || 20;
      const logs = usageService.getRecentLogs(limit);
      res.json({ logs });
    } catch (err) { next(err); }
  });

  return router;
}
