import { Router, Request, Response, NextFunction } from 'express';
import type { Database } from 'better-sqlite3';
import { createError } from '../middleware/error-handler';
import { EvidenceService } from '../services/evidence-service';
import { EvidenceType, EvidenceSeverity } from '@djimitflo/shared';

export function createEvidenceRoutes(db: Database): Router {
  const router = Router();
  const evidenceService = new EvidenceService(db);

  router.get('/task/:taskId', (req: Request, res: Response, next: NextFunction) => {
    try {
      const { taskId } = req.params;
      const evidence_type = req.query.evidence_type as EvidenceType | undefined;
      const severity = req.query.severity as EvidenceSeverity | undefined;

      const evidence = evidenceService.getTaskEvidence(taskId, { evidence_type, severity });
      res.json({ evidence });
    } catch (error) {
      next(error);
    }
  });

  router.get('/summary/:taskId', (req: Request, res: Response, next: NextFunction) => {
    try {
      const { taskId } = req.params;
      const summary = evidenceService.getExecutionSummary(taskId);

      if (!summary) {
        const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId);
        if (!task) {
          throw createError(404, 'Task not found', 'TASK_NOT_FOUND');
        }
      }

      res.json({ summary });
    } catch (error) {
      next(error);
    }
  });

  router.get('/file-changes/:taskId', (req: Request, res: Response, next: NextFunction) => {
    try {
      const { taskId } = req.params;
      const changes = evidenceService.getFileChanges(taskId);
      res.json({ file_changes: changes });
    } catch (error) {
      next(error);
    }
  });

  router.get('/audit-trail/:taskId', (req: Request, res: Response, next: NextFunction) => {
    try {
      const { taskId } = req.params;
      const trail = evidenceService.getAuditTrail(taskId);
      res.json({ trail });
    } catch (error) {
      next(error);
    }
  });

  router.get('/review/:taskId', (req: Request, res: Response, next: NextFunction) => {
    try {
      const { taskId } = req.params;

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
      if (!task) {
        throw createError(404, 'Task not found', 'TASK_NOT_FOUND');
      }

      const summary = evidenceService.getExecutionSummary(taskId);
      const evidence = evidenceService.getTaskEvidence(taskId);
      const fileChanges = evidenceService.getFileChanges(taskId);
      const auditTrail = evidenceService.getAuditTrail(taskId);

      const parsedTask = {
        ...task,
        tags: JSON.parse(task.tags || '[]'),
        metadata: JSON.parse(task.metadata || '{}'),
      };

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