import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { AuditService } from '../services/audit-service';
import type { AuditQuery } from '@djimitflo/shared';

export function createAuditRoutes(db: Database, auditService: AuditService, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  router.get('/', requirePermission('manage:config'), (req, res, next) => {
    try {
      const query: AuditQuery = {};
      if (req.query.event_type) query.event_types = (req.query.event_type as string).split(',') as any;
      if (req.query.user_id) query.user_id = req.query.user_id as string;
      if (req.query.agent_id) query.agent_id = req.query.agent_id as string;
      if (req.query.task_id) query.task_id = req.query.task_id as string;
      if (req.query.resource_type) query.resource_type = req.query.resource_type as string;
      if (req.query.risk_level) query.risk_level = req.query.risk_level as any;
      if (req.query.from) query.from_date = req.query.from as string;
      if (req.query.to) query.to_date = req.query.to as string;
      if (req.query.limit) query.limit = parseInt(req.query.limit as string, 10);
      if (req.query.offset) query.offset = parseInt(req.query.offset as string, 10);

      const result = auditService.query(query);
      res.json({
        events: result.events,
        total: result.total,
        page: Math.floor((query.offset ?? 0) / (query.limit ?? 50)) + 1,
      });
    } catch (err) { next(err); }
  });

  router.get('/:id', requirePermission('manage:config'), (req, res, next) => {
    try {
      const row = db.prepare('SELECT * FROM audit_events WHERE id = ?').get(req.params.id) as any;
      if (!row) {
        res.status(404).json({ error: { message: 'Audit event not found', code: 'NOT_FOUND' } });
        return;
      }
      res.json(auditService.sanitizeAuditEvent(row));
    } catch (err) { next(err); }
  });

  return router;
}
