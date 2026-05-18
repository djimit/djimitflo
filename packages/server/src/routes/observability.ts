import { Router, Request, Response, NextFunction } from 'express';
import type { Database } from 'better-sqlite3';
import { EvidenceService } from '../services/evidence-service';
import type { AuthMiddleware } from '../middleware/auth';

export function createObservabilityRoutes(db: Database, auth: AuthMiddleware): Router {
  const router = Router();
  const evidenceService = new EvidenceService(db);
  const requireAuth = auth.requireAuth;
  const requireAdmin = auth.requirePermission('manage:config');

  // GET /observability/metrics — admin-only
  router.get('/metrics', requireAuth, requireAdmin, (_req: Request, res: Response, next: NextFunction) => {
    try {
      const metrics = evidenceService.getObservabilityMetrics();
      res.json(metrics);
    } catch (error) {
      next(error);
    }
  });

  // GET /observability/risk-trends — admin-only
  router.get('/risk-trends', requireAuth, requireAdmin, (req: Request, res: Response, next: NextFunction) => {
    try {
      const days = parseInt(req.query.days as string) || 30;

      const trends = db.prepare(`
        SELECT
          DATE(created_at) as date,
          risk_level,
          COUNT(*) as count
        FROM risk_assessments
        WHERE created_at >= datetime('now', '-' || ? || ' days')
        GROUP BY DATE(created_at), risk_level
        ORDER BY date ASC, risk_level ASC
      `).all(days) as any[];

      res.json({ trends });
    } catch (error) {
      next(error);
    }
  });

  // GET /observability/policy-stats — admin-only
  router.get('/policy-stats', requireAuth, requireAdmin, (_req: Request, res: Response, next: NextFunction) => {
    try {
      const policyStats = db.prepare(`
        SELECT
          ap.id,
          ap.name,
          ap.decision,
          ap.enabled,
          ap.priority
        FROM approval_policies ap
        ORDER BY ap.priority DESC
      `).all() as any[];

      const totalDecisions = db.prepare(`
        SELECT recommended_decision, COUNT(*) as count
        FROM risk_assessments
        GROUP BY recommended_decision
      `).all() as any[];

      const recentDenials = db.prepare(`
        SELECT task_id, explanation, created_at
        FROM risk_assessments
        WHERE recommended_decision = 'deny'
        ORDER BY created_at DESC
        LIMIT 10
      `).all() as any[];

      res.json({
        policies: policyStats,
        decisions: totalDecisions,
        recent_denials: recentDenials,
      });
    } catch (error) {
      next(error);
    }
  });

  // GET /observability/execution-activity — admin-only
  router.get('/execution-activity', requireAuth, requireAdmin, (req: Request, res: Response, next: NextFunction) => {
    try {
      const hours = parseInt(req.query.hours as string) || 24;

      const activity = db.prepare(`
        SELECT
          DATETIME(created_at) as timestamp,
          status,
          COUNT(*) as count
        FROM tasks
        WHERE created_at >= datetime('now', '-' || ? || ' hours')
        GROUP BY DATETIME(created_at), status
        ORDER BY timestamp ASC
      `).all(hours) as any[];

      const recentTasks = db.prepare(`
        SELECT id, title, status, risk_level, execution_mode, created_at, updated_at
        FROM tasks
        ORDER BY updated_at DESC
        LIMIT 20
      `).all() as any[];

      res.json({ activity, recent_tasks: recentTasks });
    } catch (error) {
      next(error);
    }
  });

  return router;
}