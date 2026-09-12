import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { UsageService } from '../services/usage-service';
import { createError } from '../middleware/error-handler';

function boundedLimit(value: unknown, fallback = 20): number {
  if (value === undefined) return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw createError(400, 'limit must be an integer between 1 and 500', 'VALIDATION_ERROR');
  }
  return limit;
}

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
      const { logs } = req.body ?? {};
      const validTaskTypes = new Set(['default', 'task', 'discussion', 'proposal', 'vote', 'learning', 'other']);
      if (!Array.isArray(logs) || logs.length === 0 || logs.length > 1000 || logs.some((log: any) => {
        if (!log || typeof log !== 'object' || typeof log.id !== 'string' || !log.id.trim()) return true;
        if (log.task_id !== undefined && (typeof log.task_id !== 'string' || !log.task_id.trim())) return true;
        if (log.agent_id !== undefined && (typeof log.agent_id !== 'string' || !log.agent_id.trim())) return true;
        if (log.provider !== undefined && (typeof log.provider !== 'string' || !log.provider.trim())) return true;
        if (log.model !== undefined && (typeof log.model !== 'string' || !log.model.trim())) return true;
        if (log.task_type !== undefined && (typeof log.task_type !== 'string' || !validTaskTypes.has(log.task_type))) return true;
        if (log.created_at !== undefined && (typeof log.created_at !== 'string' || !Number.isFinite(Date.parse(log.created_at)))) return true;
        return ['prompt_tokens', 'completion_tokens', 'total_tokens', 'latency_ms'].some((field) =>
          log[field] !== undefined && (!Number.isInteger(log[field]) || log[field] < 0 || log[field] > 1_000_000_000_000));
      })) {
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
      const limit = boundedLimit(req.query.limit);
      const logs = usageService.getRecentLogs(limit);
      res.json({ logs });
    } catch (err) { next(err); }
  });

  return router;
}
