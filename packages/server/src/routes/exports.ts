import { Router, Request, Response } from 'express';
import type { Database } from 'better-sqlite3';
import { ExportFormat } from '@djimitflo/shared';
import type { AuthTokenPayload, ExportRequest } from '@djimitflo/shared';
import { ExportService, ExportError } from '../services/export-service';
import type { AuthMiddleware } from '../middleware/auth';

export function createExportRoutes(db: Database, auth: AuthMiddleware): Router {
  const router = Router();
  const exportService = new ExportService(db);
  const requireAuth = auth.requireAuth;

  function getUser(req: Request): AuthTokenPayload {
    return (req as any).user;
  }

  function handleExportResult(res: Response, result: { contentType: string; filename: string; data: string }) {
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.data);
  }

  function parseExportRequest(body: any): ExportRequest {
    const format = Object.values(ExportFormat).includes(body?.format)
      ? body.format
      : ExportFormat.JSON;
    return {
      format,
      includeDiffs: body?.includeDiffs ?? true,
      includeAudit: body?.includeAudit ?? true,
      includeMetadata: body?.includeMetadata ?? true,
      dateFrom: body?.dateFrom,
      dateTo: body?.dateTo,
    };
  }

  function handleError(res: Response, error: unknown) {
    if (error instanceof ExportError) {
      res.status(error.statusCode).json({ error: { message: error.message, code: error.code } });
    } else {
      res.status(500).json({ error: { message: 'Export failed', code: 'EXPORT_ERROR' } });
    }
  }

  // POST /exports/task/:taskId
  router.post('/task/:taskId', requireAuth, (req: Request, res: Response) => {
    try {
      const user = getUser(req);
      const options = parseExportRequest(req.body);
      const result = exportService.exportTask(req.params.taskId, user, options);
      handleExportResult(res, result);
    } catch (error) {
      handleError(res, error);
    }
  });

  // POST /exports/evidence/:taskId
  router.post('/evidence/:taskId', requireAuth, (req: Request, res: Response) => {
    try {
      const user = getUser(req);
      const options = parseExportRequest(req.body);
      const result = exportService.exportEvidence(req.params.taskId, user, options);
      handleExportResult(res, result);
    } catch (error) {
      handleError(res, error);
    }
  });

  // POST /exports/audit
  router.post('/audit', requireAuth, (req: Request, res: Response) => {
    try {
      const user = getUser(req);
      const options = parseExportRequest(req.body);
      const result = exportService.exportAudit(user, options);
      handleExportResult(res, result);
    } catch (error) {
      handleError(res, error);
    }
  });

  // POST /exports/repository/:repositoryId
  router.post('/repository/:repositoryId', requireAuth, (req: Request, res: Response) => {
    try {
      const user = getUser(req);
      const options = parseExportRequest(req.body);
      const result = exportService.exportRepository(req.params.repositoryId, user, options);
      handleExportResult(res, result);
    } catch (error) {
      handleError(res, error);
    }
  });

  // POST /exports/report/summary
  router.post('/report/summary', requireAuth, (req: Request, res: Response) => {
    try {
      const user = getUser(req);
      const options = parseExportRequest(req.body);
      const result = exportService.exportSummaryReport(user, options);
      handleExportResult(res, result);
    } catch (error) {
      handleError(res, error);
    }
  });

  // GET /exports/training — leakage-free JSONL training dataset
  router.get('/training', requireAuth, (req: Request, res: Response): void => {
    try {
      const user = getUser(req);
      if (user.role !== 'admin') {
        res.status(403).json({ error: { message: 'Admin required', code: 'FORBIDDEN' } });
        return;
      }

      const tasks = db.prepare(`
        SELECT t.id, t.title, t.description, t.status, t.created_by, t.completed_at, t.created_at,
               a.agent_type, a.name as agent_name,
               ap.status as approval_status, ap.decided_by, ap.denial_reason
        FROM tasks t
        LEFT JOIN agents a ON t.agent_id = a.id
        LEFT JOIN (
          SELECT task_id, status, decided_by, denial_reason,
                 ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY created_at DESC) as rn
          FROM approvals
        ) ap ON t.id = ap.task_id AND ap.rn = 1
        WHERE t.status IN ('completed', 'failed') OR ap.status IS NOT NULL
        ORDER BY t.created_at DESC
      `).all() as any[];

      const lines = tasks.map((t: any) => {
        const outcome = t.approval_status === 'approved' ? 'approved'
          : t.approval_status === 'denied' ? 'denied'
          : t.status === 'completed' ? 'auto_completed' : 'unknown';

        return JSON.stringify({
          task_id: t.id,
          title: t.title,
          machine_id: t.created_by || 'unknown',
          agent_type: t.agent_type || 'unknown',
          skill_used: null,
          output_excerpt: (t.description || '').slice(0, 500),
          outcome,
          denial_reason: t.denial_reason || undefined,
          completed_at: t.completed_at || undefined,
          created_at: t.created_at,
        });
      });

      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Content-Disposition', 'attachment; filename="training-export.jsonl"');
      res.send(lines.join('\n'));
      return;
    } catch (error) {
      handleError(res, error);
      return;
    }
  });

  return router;
}