import { Router, Request, Response, NextFunction } from 'express';
import type { Database } from 'better-sqlite3';

export function createUsageRoutes(db: Database): Router {
  const router = Router();

  // GET /usage/quotas — provider_configs with aggregated token usage
  router.get('/quotas', (_req: Request, res: Response, next: NextFunction) => {
    try {
      const quotas = db.prepare(`
        SELECT
          pc.provider,
          pc.subscription_tier AS tier,
          pc.is_active,
          pc.token_quota_hourly AS quota_hourly,
          pc.token_quota_daily AS quota_daily,
          pc.token_quota_weekly AS quota_weekly,
          pc.token_quota_monthly AS quota_monthly,
          pc.rate_limit_rpm,
          pc.rate_limit_rpd,
          pc.cost_per_1k_prompt_tokens AS cost_per_1k_prompt,
          pc.cost_per_1k_completion_tokens AS cost_per_1k_completion,
          COALESCE(SUM(CASE WHEN tul.timestamp >= datetime('now', '-1 hour')  THEN tul.prompt_tokens + tul.completion_tokens ELSE 0 END), 0) AS tokens_used_hourly,
          COALESCE(SUM(CASE WHEN tul.timestamp >= datetime('now', '-1 day')   THEN tul.prompt_tokens + tul.completion_tokens ELSE 0 END), 0) AS tokens_used_daily,
          COALESCE(SUM(CASE WHEN tul.timestamp >= datetime('now', '-7 days')  THEN tul.prompt_tokens + tul.completion_tokens ELSE 0 END), 0) AS tokens_used_weekly,
          COALESCE(SUM(CASE WHEN tul.timestamp >= datetime('now', '-30 days') THEN tul.prompt_tokens + tul.completion_tokens ELSE 0 END), 0) AS tokens_used_monthly,
          COALESCE(SUM(tul.cost), 0) AS cost_total
        FROM provider_configs pc
        LEFT JOIN token_usage_log tul ON tul.provider = pc.provider
        GROUP BY pc.provider
        ORDER BY pc.provider
      `).all() as any[];

      res.json({ quotas });
    } catch (error) {
      next(error);
    }
  });

  // GET /usage/tokens?group_by=day — aggregated token usage
  router.get('/tokens', (req: Request, res: Response, next: NextFunction) => {
    try {
      const groupBy = req.query.group_by as string || 'day';
      const days = parseInt(req.query.days as string) || 30;

      const dateFn = groupBy === 'hour'
        ? `strftime('%Y-%m-%dT%H:00', timestamp)`
        : `DATE(timestamp)`;

      const breakdown = db.prepare(`
        SELECT
          ${dateFn} AS date,
          SUM(prompt_tokens + completion_tokens) AS tokens,
          SUM(cost) AS cost
        FROM token_usage_log
        WHERE timestamp >= datetime('now', '-' || ? || ' days')
        GROUP BY ${dateFn}
        ORDER BY date ASC
      `).all(days) as any[];

      const totals = db.prepare(`
        SELECT
          COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS total_tokens,
          COALESCE(SUM(cost), 0) AS total_cost
        FROM token_usage_log
        WHERE timestamp >= datetime('now', '-' || ? || ' days')
      `).get(days) as any;

      res.json({
        total_tokens: totals.total_tokens,
        total_cost: totals.total_cost,
        breakdown,
      });
    } catch (error) {
      next(error);
    }
  });

  // GET /usage/recent?limit=20 — recent token usage log entries
  router.get('/recent', (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 200);

      const logs = db.prepare(`
        SELECT
          tul.id,
          tul.timestamp,
          tul.provider,
          tul.model,
          tul.task_id,
          tul.prompt_tokens,
          tul.completion_tokens,
          tul.cost
        FROM token_usage_log tul
        ORDER BY tul.timestamp DESC
        LIMIT ?
      `).all(limit) as any[];

      res.json({ logs });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
