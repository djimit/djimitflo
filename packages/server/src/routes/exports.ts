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

  return router;
}