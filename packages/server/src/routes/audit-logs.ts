import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Database } from 'better-sqlite3';

export function createAuditLogRoutes(db: Database, requireAuthMiddleware?: any): Router {
  const router = Router();
  const auditLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });

  /**
   * GET /api/audit-logs
   * Geef audit logs terug (gefilterd op organization_id, met paginering).
   */
  router.get('/', auditLimiter, requireAuthMiddleware, (req, res) => {
    const user = req.user as any;
    const organizationId = user?.organization_id ?? 'default';
    const { limit = 50, offset = 0, entity_type, action } = req.query;

    let query = 'SELECT * FROM audit_logs WHERE organization_id = ?';
    const params: unknown[] = [organizationId];

    if (entity_type) {
      query += ' AND entity_type = ?';
      params.push(entity_type);
    }
    if (action) {
      query += ' AND action = ?';
      params.push(action);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const logs = db.prepare(query).all(...params) as any[];
    res.json(logs);
  });

  /**
   * GET /api/audit-logs/export
   * Exporteer audit logs als CSV/JSON.
   */
  router.get('/export', auditLimiter, requireAuthMiddleware, (req, res) => {
    const user = req.user as any;
    const organization_id = user?.organization_id ?? 'default';
    const { format = 'json' } = req.query;
    const logs = db.prepare(
      'SELECT * FROM audit_logs WHERE organization_id = ? ORDER BY created_at DESC'
    ).all(organization_id) as any[];

    if (format === 'csv') {
      const csv = logs.map(log => {
        let testField = '';
        try { testField = JSON.parse(log.metadata || '{}').test || ''; } catch { testField = ''; }
        return [
          log.id,
          log.organization_id,
          log.entity_type,
          log.entity_id,
          log.action,
          log.created_at,
          testField,
        ].join(',');
      }).join('\n');
      res.header('Content-Type', 'text/csv');
      res.attachment('audit-logs.csv');
      res.send(csv);
    } else {
      res.json(logs);
    }
  });

  return router;
}