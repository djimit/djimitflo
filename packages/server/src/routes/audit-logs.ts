import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Database } from 'better-sqlite3';
import { AuthorizationService } from '../services/authorization-service';
import { createError } from '../middleware/error-handler';

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw createError(400, `${name} must be an integer between ${minimum} and ${maximum}`, 'VALIDATION_ERROR');
  }
  return parsed;
}

/**
 * Audit-log viewer endpoints — FR-011.
 *
 * Reads from `audit_events`, the table every production write goes through
 * via AuditService.record (review fix: the earlier draft queried a separate
 * `audit_logs` table that nothing wrote to, leaving the viewer empty).
 */
export function createAuditLogRoutes(db: Database, requireAuthMiddleware?: any): Router {
  const router = Router();
  router.use(requireAuthMiddleware, (req: any, res, next) => {
    if (!req.user || !AuthorizationService.hasPermission(req.user, 'read:audit')) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Audit read permission required' } });
      return;
    }
    next();
  });
  const auditLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });

  /**
   * GET /api/audit-logs?limit=&offset=&entity_type=&action=&entity_id=
   * Recent audit events, newest first.
   */
  router.get('/', auditLimiter, requireAuthMiddleware, (req, res) => {
    const { limit = 50, offset = 0, resource_type, action, resource_id } = req.query;

    let query = 'SELECT * FROM audit_events WHERE 1=1';
    const params: unknown[] = [];

    if (resource_type) {
      query += ' AND resource_type = ?';
      params.push(resource_type);
    }
    if (action) {
      query += ' AND action = ?';
      params.push(action);
    }
    if (resource_id) {
      query += ' AND resource_id = ?';
      params.push(resource_id);
    }

    query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(
      boundedInteger(limit, 50, 1, 10_000, 'limit'),
      boundedInteger(offset, 0, 0, 1_000_000, 'offset'),
    );

    const logs = db.prepare(query).all(...params) as any[];
    res.json(logs);
  });

  /**
   * GET /api/audit-logs/export?format=csv|json
   */
  router.get('/export', auditLimiter, requireAuthMiddleware, (req, res) => {
    const { format = 'json', since } = req.query;
    let logs: any[];
    if (since) {
      logs = db.prepare(
        'SELECT * FROM audit_events WHERE timestamp >= ? ORDER BY timestamp DESC'
      ).all(since) as any[];
    } else {
      logs = db.prepare(
        'SELECT * FROM audit_events ORDER BY timestamp DESC LIMIT 10000'
      ).all() as any[];
    }

    if (format === 'csv') {
      const header = 'id,timestamp,event_type,action,resource_type,resource_id,user_id,risk_level';
      const rows = logs.map(log =>
        [log.id, log.timestamp, log.event_type, log.action, log.resource_type, log.resource_id, log.user_id, log.risk_level]
          .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`)
          .join(',')
      ).join('\n');
      res.header('Content-Type', 'text/csv');
      res.attachment('audit-logs.csv');
      res.send(header + '\n' + rows);
    } else {
      res.json(logs);
    }
  });

  return router;
}
