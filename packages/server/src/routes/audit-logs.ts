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
 * Legacy filter values the viewer used to send that never matched a stored
 * resource_type (DF-04: the Loop option sent `loop`, writers store `loop_run`).
 * The canonical value is first; the alias itself is kept so any row that was
 * ever written with it stays reachable.
 */
const RESOURCE_TYPE_ALIASES: Record<string, string[]> = { loop: ['loop_run', 'loop'] };

/** One filter for list and export, so an export never has a different scope than the list. */
function auditFilter(query: Record<string, unknown>): { where: string; params: unknown[]; filtered: boolean } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const name of ['resource_type', 'action', 'resource_id', 'since']) {
    if (query[name] !== undefined && typeof query[name] !== 'string') {
      throw createError(400, `${name} must be a single value`, 'VALIDATION_ERROR');
    }
  }
  const { resource_type, action, resource_id, since } = query;
  if (typeof resource_type === 'string' && resource_type) {
    const types = RESOURCE_TYPE_ALIASES[resource_type] ?? [resource_type];
    clauses.push(`resource_type IN (${types.map(() => '?').join(', ')})`);
    params.push(...types);
  }
  if (typeof action === 'string' && action) { clauses.push('action = ?'); params.push(action); }
  if (typeof resource_id === 'string' && resource_id) { clauses.push('resource_id = ?'); params.push(resource_id); }
  if (typeof since === 'string' && since) { clauses.push('timestamp >= ?'); params.push(since); }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params, filtered: clauses.length > 0 };
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
   * GET /api/audit-logs?limit=&offset=&resource_type=&action=&resource_id=
   * Recent audit events, newest first. X-Total-Count / X-Has-More headers carry paging state.
   */
  router.get('/', auditLimiter, requireAuthMiddleware, (req, res) => {
    const limit = boundedInteger(req.query.limit, 50, 1, 10_000, 'limit');
    const offset = boundedInteger(req.query.offset, 0, 0, 1_000_000, 'offset');
    const { where, params } = auditFilter(req.query);
    // Body stays a plain array (existing contract); paging state travels in headers.
    const rows = db.prepare(`SELECT * FROM audit_events ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`)
      .all(...params, limit + 1, offset) as any[];
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM audit_events ${where}`).get(...params) as { count: number }).count;
    res.setHeader('X-Total-Count', String(total));
    res.setHeader('X-Has-More', String(rows.length > limit));
    res.json(rows.slice(0, limit));
  });

  /**
   * GET /api/audit-logs/export?format=csv|json&resource_type=&action=&resource_id=&since=
   */
  router.get('/export', auditLimiter, requireAuthMiddleware, (req, res) => {
    const { format = 'json' } = req.query;
    const { where, params, filtered } = auditFilter(req.query);
    // Same filter scope as the list. A `since`-only export keeps its historical
    // unbounded behaviour; every other export keeps the 10k cap.
    const cap = req.query.since ? '' : ' LIMIT 10000';
    const logs = db.prepare(`SELECT * FROM audit_events ${where} ORDER BY timestamp DESC${cap}`).all(...params) as any[];
    res.setHeader('X-Audit-Export-Scope', filtered ? 'filtered' : 'full');

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
