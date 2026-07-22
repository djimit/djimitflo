import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { createError } from '../middleware/error-handler';
import { AuthTokenPayload } from '@djimitflo/shared';
import { AuthorizationService } from '../services/authorization-service';
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

  function getUser(req: any): AuthTokenPayload {
    return (req as any).user;
  }

  function loadApprovalOr404(id: string, res: any): any | null {
    const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id);
    if (!approval) {
      res.status(404).json({ error: { message: 'Approval not found', code: 'APPROVAL_NOT_FOUND' } });
      return null;
    }
    return approval;
  }

  function loadTaskForApproval(approval: any): any | null {
    if (!approval || !approval.task_id) return null;
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(approval.task_id) as any;
  }

  function canAccessApprovalTask(user: AuthTokenPayload, approval: any): boolean {
    if (AuthorizationService.isAdmin(user)) return true;
    const task = loadTaskForApproval(approval);
    if (!task) return true;
    return AuthorizationService.canReadTask(user, task);
  }

  // GET /api/approvals - List approvals (filtered by task ownership for non-admin)
  router.get('/', (req, res, next) => {
    try {
      const { status } = req.query;
      const user = getUser(req);

      if (AuthorizationService.isAdmin(user)) {
        let query = 'SELECT * FROM approvals';
        const params: any[] = [];
        if (status) {
          query += ' WHERE status = ?';
          params.push(status);
        }
        query += ' ORDER BY created_at DESC';
        const approvals = db.prepare(query).all(...params);
        res.json({ approvals: (approvals as any[]).map(parseApproval) });
      } else {
        const visibility = AuthorizationService.getApprovalTaskVisibilityWhere(user);
        let query = 'SELECT a.* FROM approvals a INNER JOIN tasks t ON a.task_id = t.id';
        const params: any[] = [];
        const where: string[] = [visibility!.clause];
        const visParams = visibility!.params;

        if (status) {
          where.push('a.status = ?');
          params.push(status);
        }

        query += ' WHERE ' + where.join(' AND ');
        params.unshift(...visParams);
        query += ' ORDER BY a.created_at DESC';

        const approvals = db.prepare(query).all(...params);
        res.json({ approvals: (approvals as any[]).map(parseApproval) });
      }
    } catch (error) {
      next(error);
    }
  });

  // GET /api/approvals/:id
  router.get('/:id', (req, res, next) => {
    try {
      const user = getUser(req);
      const approval = loadApprovalOr404(req.params.id, res);
      if (!approval) return;

      if (!canAccessApprovalTask(user, approval)) {
        res.status(404).json({ error: { message: 'Approval not found', code: 'APPROVAL_NOT_FOUND' } });
        return;
      }

      res.json(parseApproval(approval));
    } catch (error) {
      next(error);
    }
  });

  // PATCH /api/approvals/:id - Backward-compatible approve or deny
  router.patch('/:id', requirePermission('approve:task'), async (req, res, next) => {
    try {
      const { id } = req.params;
      const { approved, reason } = req.body;
      const user = getUser(req);

      const approval = loadApprovalOr404(id, res);
      if (!approval) return;

      if (!canAccessApprovalTask(user, approval)) {
        res.status(404).json({ error: { message: 'Approval not found', code: 'APPROVAL_NOT_FOUND' } });
        return;
      }

      if (!executionEngine) {
        throw createError(503, 'Execution engine not available', 'ENGINE_UNAVAILABLE');
      }

      const decidedBy = user?.sub || 'system';

      try {
        await executionEngine.handleApprovalDecision(id, Boolean(approved), decidedBy, reason);
      } catch (error) {
        if (error instanceof Error && error.message.includes('SELF_APPROVAL_FORBIDDEN')) {
          res.status(409).json({ error: { message: error.message, code: 'SELF_APPROVAL_FORBIDDEN' } });
          return;
        }
        throw error;
      }

      const updated = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as any;
      res.json(parseApproval(updated));
    } catch (error) {
      next(error);
    }
  });

  // POST /api/approvals/:id/approve
  router.post('/:id/approve', requirePermission('approve:task'), async (req, res, next) => {
    try {
      const user = getUser(req);

      const approval = loadApprovalOr404(req.params.id, res);
      if (!approval) return;

      if (!canAccessApprovalTask(user, approval)) {
        res.status(404).json({ error: { message: 'Approval not found', code: 'APPROVAL_NOT_FOUND' } });
        return;
      }

      if (!executionEngine) {
        throw createError(503, 'Execution engine not available', 'ENGINE_UNAVAILABLE');
      }

      const decidedBy = user?.sub || 'system';

      try {
        await executionEngine.handleApprovalDecision(req.params.id, true, decidedBy, req.body.reason);
      } catch (error) {
        if (error instanceof Error && error.message.includes('SELF_APPROVAL_FORBIDDEN')) {
          res.status(409).json({ error: { message: error.message, code: 'SELF_APPROVAL_FORBIDDEN' } });
          return;
        }
        throw error;
      }

      const updated = db.prepare('SELECT * FROM approvals WHERE id = ?').get(req.params.id) as any;
      res.json(parseApproval(updated));
    } catch (error) {
      next(error);
    }
  });

  // POST /api/approvals/:id/deny
  router.post('/:id/deny', requirePermission('approve:task'), async (req, res, next) => {
    try {
      const user = getUser(req);

      const approval = loadApprovalOr404(req.params.id, res);
      if (!approval) return;

      if (!canAccessApprovalTask(user, approval)) {
        res.status(404).json({ error: { message: 'Approval not found', code: 'APPROVAL_NOT_FOUND' } });
        return;
      }

      if (!executionEngine) {
        throw createError(503, 'Execution engine not available', 'ENGINE_UNAVAILABLE');
      }

      const decidedBy = user?.sub || 'system';

      try {
        await executionEngine.handleApprovalDecision(req.params.id, false, decidedBy, req.body.reason);
      } catch (error) {
        if (error instanceof Error && error.message.includes('SELF_APPROVAL_FORBIDDEN')) {
          res.status(409).json({ error: { message: error.message, code: 'SELF_APPROVAL_FORBIDDEN' } });
          return;
        }
        throw error;
      }
      const updated = db.prepare('SELECT * FROM approvals WHERE id = ?').get(req.params.id) as any;
      res.json(parseApproval(updated));
    } catch (error) {
      next(error);
    }
  });

  // POST /api/approvals/:id/cancel
  router.post('/:id/cancel', requirePermission('approve:task'), (req, res, next) => {
    try {
      const { id } = req.params;
      const user = getUser(req);

      const approval = loadApprovalOr404(id, res);
      if (!approval) return;

      if (!canAccessApprovalTask(user, approval)) {
        res.status(404).json({ error: { message: 'Approval not found', code: 'APPROVAL_NOT_FOUND' } });
        return;
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