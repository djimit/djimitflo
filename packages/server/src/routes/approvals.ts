/**
 * Approval routes
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { createError } from '../middleware/error-handler';
import type { ExecutionEngine } from '../execution/execution-engine';
import type { AuthMiddleware } from '../middleware/auth';

function parseApproval(approval: any) {
  return {
    ...approval,
    request_data: JSON.parse(approval.request_data || '{}'),
    metadata: JSON.parse(approval.metadata || '{}'),
  };
}

export function createApprovalRoutes(db: Database, executionEngine?: ExecutionEngine, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  router.get('/', (req, res, next) => {
    try {
      const { status } = req.query;
      let query = 'SELECT * FROM approvals';
      const params: any[] = [];

      if (status) {
        query += ' WHERE status = ?';
        params.push(status);
      }

      query += ' ORDER BY created_at DESC';
      const approvals = db.prepare(query).all(...params);
      res.json({ approvals: (approvals as any[]).map(parseApproval) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id', (req, res, next) => {
    try {
      const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(req.params.id) as any;
      if (!approval) {
        throw createError(404, 'Approval not found', 'APPROVAL_NOT_FOUND');
      }
      res.json(parseApproval(approval));
    } catch (error) {
      next(error);
    }
  });

  // PATCH /api/approvals/:id - Backward-compatible approve or deny a request
  router.patch('/:id', requirePermission('approve:task'), async (req, res, next) => {
    try {
      const { id } = req.params;
      const { approved, reason } = req.body;

      if (!executionEngine) {
        throw createError(503, 'Execution engine not available', 'ENGINE_UNAVAILABLE');
      }

      await executionEngine.handleApprovalDecision(id, Boolean(approved), reason, req.user?.sub);

      const updated = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as any;
      res.json(parseApproval(updated));
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/approve', requirePermission('approve:task'), async (req, res, next) => {
    try {
      if (!executionEngine) {
        throw createError(503, 'Execution engine not available', 'ENGINE_UNAVAILABLE');
      }
      await executionEngine.handleApprovalDecision(req.params.id, true, req.body.reason, req.user?.sub);
      const updated = db.prepare('SELECT * FROM approvals WHERE id = ?').get(req.params.id) as any;
      res.json(parseApproval(updated));
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/deny', requirePermission('approve:task'), async (req, res, next) => {
    try {
      if (!executionEngine) {
        throw createError(503, 'Execution engine not available', 'ENGINE_UNAVAILABLE');
      }
      await executionEngine.handleApprovalDecision(req.params.id, false, req.body.reason, req.user?.sub);
      const updated = db.prepare('SELECT * FROM approvals WHERE id = ?').get(req.params.id) as any;
      res.json(parseApproval(updated));
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/cancel', requirePermission('approve:task'), (req, res, next) => {
    try {
      const { id } = req.params;
      const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as any;
      if (!approval) {
        throw createError(404, 'Approval not found', 'APPROVAL_NOT_FOUND');
      }
      db.prepare("UPDATE approvals SET status = 'expired', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
      const updated = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as any;
      res.json(parseApproval(updated));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
