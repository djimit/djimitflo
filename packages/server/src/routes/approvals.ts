import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { createError } from '../middleware/error-handler';
import { ApprovalRequestType, AuthTokenPayload, RiskLevel } from '@djimitflo/shared';
import { z } from 'zod';
import { AuthorizationService } from '../services/authorization-service';
import { ApprovalService } from '../services/approval-service';
import { AuditService } from '../services/audit-service';
import type { WebSocketService } from '../services/websocket-service';
import type { ExecutionEngine } from '../execution/execution-engine';
import type { AuthMiddleware } from '../middleware/auth';

function parseApproval(approval: any) {
  return {
    ...approval,
    request_data: JSON.parse(approval.request_data || '{}'),
    metadata: JSON.parse(approval.metadata || '{}'),
  };
}

export function createApprovalRoutes(db: Database, executionEngine?: ExecutionEngine, auth?: AuthMiddleware, wsService?: WebSocketService): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  function getUser(req: any): AuthTokenPayload {
    return (req as any).user;
  }

  // Human review of an action attached to an existing task. A decision records
  // authorization only; it cannot dispatch arbitrary task metadata as a command.
  router.post('/', requirePermission('create:task'), (req, res, next) => {
    try {
      const parsed = z.object({
        task_id: z.string().min(1), action: z.string().trim().min(1).max(4000),
        reason: z.string().trim().min(1).max(10000),
        risk_level: z.enum(RiskLevel), context: z.record(z.string(), z.unknown()).default({}),
      }).safeParse(req.body);
      if (!parsed.success) throw createError(400, 'Valid task_id, action, reason and risk_level are required', 'INVALID_INPUT');
      const input = parsed.data;
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(input.task_id) as any;
      if (!task || !AuthorizationService.canModifyTask(getUser(req), task)) {
        throw createError(404, 'Task not found', 'TASK_NOT_FOUND');
      }
      const service = new ApprovalService(db, wsService || { broadcastTaskEventById: () => {} }, new AuditService(db));
      const approval = service.createApproval({
        task, title: input.action, description: input.reason,
        requestedBy: getUser(req).sub, requestType: ApprovalRequestType.HIGH_RISK_ACTION,
        assessment: {
          action_type: 'unknown', risk_level: input.risk_level,
          matched_rules: [], explanation: input.reason, recommended_decision: 'require_approval',
          metadata: { action: input.action, context: input.context },
        },
        metadata: { manual_action: true, context: input.context },
      });
      res.status(201).json(approval);
    } catch (error) { next(error); }
  });

  function loadApprovalOr404(id: string, res: any): any | null {
    const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id);
    if (!approval) {
      res.status(404).json({ error: { message: 'Approval not found', code: 'APPROVAL_NOT_FOUND' } });
      return null;
    }
    return approval;
  }

  function sendDecisionError(error: unknown, res: any): boolean {
    if (!(error instanceof Error)) return false;
    if (error.message.startsWith('INVALID_APPROVAL_DECISION:')) {
      res.status(400).json({ error: { message: error.message, code: 'INVALID_APPROVAL_DECISION' } });
      return true;
    }
    const code = error.message.includes('SELF_APPROVAL_FORBIDDEN')
      ? 'SELF_APPROVAL_FORBIDDEN'
      : error.message.includes('APPROVAL_EXPIRED') ? 'APPROVAL_EXPIRED' : null;
    if (!code) return false;
    res.status(code === 'APPROVAL_EXPIRED' ? 410 : 409).json({ error: { message: error.message, code } });
    return true;
  }

  function loadTaskForApproval(approval: any): any | null {
    if (!approval || !approval.task_id) return null;
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(approval.task_id) as any;
  }

  function canAccessApprovalTask(user: AuthTokenPayload, approval: any): boolean {
    if (AuthorizationService.getApprovalTaskVisibilityWhere(user) === null) return true;
    const task = loadTaskForApproval(approval);
    if (!task) return false;
    return AuthorizationService.canReadTask(user, task);
  }

  // GET /api/approvals - List approvals (filtered by task ownership for non-admin)
  router.get('/', (req, res, next) => {
    try {
      const { status } = req.query;
      const user = getUser(req);
      const visibility = AuthorizationService.getApprovalTaskVisibilityWhere(user);

      if (!visibility) {
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
        let query = 'SELECT a.* FROM approvals a INNER JOIN tasks ON a.task_id = tasks.id';
        const params: any[] = [];
        const where: string[] = [visibility.clause];
        const visParams = visibility.params;

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
        await executionEngine.handleApprovalDecision(id, approved, decidedBy, reason);
      } catch (error) {
        if (sendDecisionError(error, res)) return;
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
        if (sendDecisionError(error, res)) return;
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
        if (sendDecisionError(error, res)) return;
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

      const result = db.prepare("UPDATE approvals SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'").run(new Date().toISOString(), id);
      if (!result.changes) {
        throw createError(409, 'Approval already processed', 'APPROVAL_ALREADY_PROCESSED');
      }
      const updated = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as any;
      res.json(parseApproval(updated));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
