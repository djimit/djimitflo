import { Router, Request, Response, NextFunction } from 'express';
import type { Database } from 'better-sqlite3';
import { EvidenceService } from '../services/evidence-service';
import { AuthorizationService } from '../services/authorization-service';
import { AuthTokenPayload } from '@djimitflo/shared';
import type { AuthMiddleware } from '../middleware/auth';

export function createEvidenceRoutes(db: Database, auth: AuthMiddleware): Router {
  const router = Router();
  const evidenceService = new EvidenceService(db);
  const requireAuth = auth.requireAuth;

  function getUser(req: Request): AuthTokenPayload {
    return (req as any).user;
  }

  function loadTaskOr404(taskId: string, res: Response): any | null {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task) {
      res.status(404).json({ error: { message: 'Task not found', code: 'TASK_NOT_FOUND' } });
      return null;
    }
    return task;
  }

  function checkTaskAccess(req: Request, res: Response, taskId: string): boolean {
    const user = getUser(req);
    const task = loadTaskOr404(taskId, res);
    if (!task) return false;
    if (!AuthorizationService.canReadTask(user, task)) {
      res.status(404).json({ error: { message: 'Task not found', code: 'TASK_NOT_FOUND' } });
      return false;
    }
    return true;
  }

  // GET /evidence/task/:taskId
  router.get('/task/:taskId', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!checkTaskAccess(req, res, req.params.taskId)) return;
      const { evidence_type, severity } = req.query;
      const filters: Record<string, string> = {};
      if (evidence_type) filters.evidence_type = evidence_type as string;
      if (severity) filters.severity = severity as string;
      const evidence = evidenceService.getTaskEvidence(req.params.taskId, filters);
      res.json({ evidence });
    } catch (error) {
      next(error);
    }
  });

  // GET /evidence/summary/:taskId
  router.get('/summary/:taskId', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!checkTaskAccess(req, res, req.params.taskId)) return;
      const summary = evidenceService.getExecutionSummary(req.params.taskId);
      if (!summary) {
        res.status(404).json({ error: { message: 'Summary not found', code: 'SUMMARY_NOT_FOUND' } });
        return;
      }
      res.json(summary);
    } catch (error) {
      next(error);
    }
  });

  // GET /evidence/file-changes/:taskId
  router.get('/file-changes/:taskId', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!checkTaskAccess(req, res, req.params.taskId)) return;
      const changes = evidenceService.getFileChanges(req.params.taskId);
      res.json({ file_changes: changes });
    } catch (error) {
      next(error);
    }
  });

  // GET /evidence/audit-trail/:taskId
  router.get('/audit-trail/:taskId', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!checkTaskAccess(req, res, req.params.taskId)) return;
      const auditTrail = evidenceService.getAuditTrail(req.params.taskId);
      res.json({ audit_trail: auditTrail });
    } catch (error) {
      next(error);
    }
  });

  // GET /evidence/review/:taskId
  router.get('/review/:taskId', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!checkTaskAccess(req, res, req.params.taskId)) return;
      const taskId = req.params.taskId;
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
      if (!task) {
        res.status(404).json({ error: { message: 'Task not found', code: 'TASK_NOT_FOUND' } });
        return;
      }
      const parsedTask = {
        ...task,
        tags: JSON.parse(task.tags || '[]'),
        metadata: JSON.parse(task.metadata || '{}'),
        created_by: task.created_by || null,
        owner_user_id: task.owner_user_id || null,
        updated_by: task.updated_by || null,
      };
      const summary = evidenceService.getExecutionSummary(taskId);
      const evidence = evidenceService.getTaskEvidence(taskId);
      const fileChanges = evidenceService.getFileChanges(taskId);
      const auditTrail = evidenceService.getAuditTrail(taskId);
      res.json({
        task: parsedTask,
        summary,
        evidence,
        file_changes: fileChanges,
        audit_trail: auditTrail,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}