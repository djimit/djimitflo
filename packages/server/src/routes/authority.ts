import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
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
 * Authority Ledger HTTP API (2026-08-30) — read-mostly query surface voor
 * de append-only authority_events tabel + provenance-joins.
 *
 * Created by the authority-ledger PR (2026-08-30); contract gelijk aan de
 * MCP-tools djimitflo_authority_trace/stats.
 */
export function createAuthorityRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission
    ?? ((_perm: string) => (_req: unknown, _res: unknown, next: () => void) => next());
  const requireLedger: import('express').RequestHandler = (_req, res, next) => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'authority_events'").get()) {
      res.status(503).json({ error: { code: 'AUTHORITY_LEDGER_UNAVAILABLE', message: 'The canonical authority ledger has not been provisioned on this instance.' } });
      return;
    }
    next();
  };

  router.get('/trace/:correlationId', requirePermission('read:evidence'), requireLedger, (req, res) => {
    try {
      const { correlationId } = req.params;
      const events = (
        db.prepare(
          `SELECT event_id, sequence, occurred_at, previous_state, requested_state,
                  policy_decision, actor_subject, actor_type, actor_issuer, source_system
           FROM authority_events WHERE correlation_id = ? ORDER BY sequence ASC`,
        ).all(correlationId) as Array<Record<string, unknown>>
      );
      const loopRuns = (
        db.prepare(
          `SELECT id, loop_name, mode, status, created_at, updated_at, completed_at
           FROM loop_runs WHERE id = ? OR metadata LIKE ? LIMIT 20`,
        ).all(correlationId, `%${correlationId}%`) as Array<Record<string, unknown>>
      );
      const approvals = (
        db.prepare(
          `SELECT id, task_id, status, risk_level, request_type, created_at
           FROM approvals WHERE task_id = ? OR request_data LIKE ? LIMIT 20`,
        ).all(correlationId, `%${correlationId}%`) as Array<Record<string, unknown>>
      );
      const violations = (
        db.prepare(
          `SELECT action_type, description, risk_level, status, created_at
           FROM policy_violations
           WHERE metadata LIKE ? OR task_id = ? OR task_id IS NULL LIMIT 20`,
        ).all(`%${correlationId}%`, correlationId) as Array<Record<string, unknown>>
      );

      res.json({
        correlation_id: correlationId,
        events,
        loop_runs: loopRuns,
        approvals,
        policy_violations: violations,
        summary: {
          event_count: events.length,
          last_decision: events.length > 0 ? events[events.length - 1].policy_decision : null,
          last_state: events.length > 0 ? events[events.length - 1].requested_state : null,
          open_violations: violations.filter((v) => String(v.status) !== 'resolved').length,
          pending_approvals: approvals.filter((a) => String(a.status) === 'pending').length,
        },
      });
    } catch (err) {
      res.status(500).json({ error: 'trace_failed', detail: String(err) });
    }
  });

  router.get('/stats', requirePermission('read:evidence'), requireLedger, (_req, res) => {
    try {
      const total = (db.prepare('SELECT COUNT(*) AS n FROM authority_events').get() as { n: number }).n;
      const byDecision = db.prepare(
        'SELECT policy_decision, COUNT(*) AS n FROM authority_events GROUP BY policy_decision',
      ).all();
      const byState = db.prepare(
        'SELECT requested_state, COUNT(*) AS n FROM authority_events GROUP BY requested_state',
      ).all();
      const bySource = db.prepare(
        'SELECT source_system, COUNT(*) AS n FROM authority_events GROUP BY source_system',
      ).all();
      const recent = db.prepare(
        `SELECT event_id, correlation_id, sequence, occurred_at, requested_state,
                policy_decision, actor_subject, source_system
         FROM authority_events WHERE policy_decision != 'ALLOW'
         ORDER BY occurred_at DESC LIMIT 20`,
      ).all();
      res.json({
        total,
        by_decision: byDecision,
        by_requested_state: byState,
        by_source_system: bySource,
        recent_denials_and_holds: recent,
      });
    } catch (err) {
      res.status(500).json({ error: 'stats_failed', detail: String(err) });
    }
  });

  router.get('/events', requirePermission('read:evidence'), requireLedger, (req, res, next) => {
    try {
      const limit = boundedInteger(req.query.limit, 50, 1, 200, 'limit');
      const offset = boundedInteger(req.query.offset, 0, 0, 1_000_000, 'offset');
      const decision = req.query.decision as string | undefined;
      const params: unknown[] = [];
      let where = '';
      if (decision && ['ALLOW', 'DENY', 'HOLD'].includes(decision)) {
        where = 'WHERE policy_decision = ?';
        params.push(decision);
      }
      const rows = db.prepare(
        `SELECT id, event_id, correlation_id, sequence, occurred_at, previous_state,
                requested_state, policy_decision, actor_subject, actor_type, source_system
         FROM authority_events ${where} ORDER BY occurred_at DESC LIMIT ? OFFSET ?`,
      ).all(...params, limit, offset);
      const total = (db.prepare(
        `SELECT COUNT(*) AS n FROM authority_events ${where}`,
      ).get(...params) as { n: number }).n;
      res.json({ events: rows, total });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
