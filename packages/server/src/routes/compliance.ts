/**
 * Compliance & Audit routes — immutable evidence chain and compliance reporting.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { ComplianceAuditService } from '../services/compliance-audit-service';
import { generateComplianceReport, exportReportAsJson, exportReportAsCsv, scanSpecsDirectory } from '../services/spec-compliance-service';
import { createError } from '../middleware/error-handler';

function boundedLimit(value: unknown, fallback = 100): number {
  if (value === undefined) return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw createError(400, 'limit must be an integer between 1 and 500', 'VALIDATION_ERROR');
  }
  return limit;
}

export function createComplianceRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const service = new ComplianceAuditService(db);
  let cachedSpecReport: ReturnType<typeof generateComplianceReport> | null = null;
  let specReportCachedAt = 0;
  const getSpecReport = (refresh = false) => {
    if (refresh || !cachedSpecReport || Date.now() - specReportCachedAt >= 60 * 60 * 1000) {
      cachedSpecReport = generateComplianceReport(scanSpecsDirectory());
      specReportCachedAt = Date.now();
    }
    return cachedSpecReport;
  };

  // GET /api/compliance/status — compliance status summary
  router.get('/status', requirePermission('read:evidence'), (_req, res) => {
    res.json(service.getStatus());
  });

  // POST /api/compliance/audit/append — append audit entry
  // SECURITY: actor is derived from authenticated principal, never from request body.
  // This prevents audit trail spoofing where a user could impersonate another actor.
  router.post('/audit/append', requirePermission('write:governance'), (req, res) => {
    const { action, resource, outcome, evidence } = req.body ?? {};
    if (typeof action !== 'string' || !action.trim() || action.length > 200) {
      throw createError(400, 'action must be a non-empty string of at most 200 characters', 'VALIDATION_ERROR');
    }
    if (resource !== undefined && (typeof resource !== 'string' || resource.length > 500)) {
      throw createError(400, 'resource must be a string of at most 500 characters', 'VALIDATION_ERROR');
    }
    if (outcome !== undefined && !['success', 'failure', 'denied'].includes(outcome)) {
      throw createError(400, 'outcome must be success, failure or denied', 'VALIDATION_ERROR');
    }
    if (evidence !== undefined && (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence))) {
      throw createError(400, 'evidence must be an object', 'VALIDATION_ERROR');
    }
    const actor = req.user?.sub || req.user?.email || 'system';
    const entry = service.appendEntry({ actor, action, resource: resource || '', outcome: outcome || 'success', evidence });
    res.status(201).json(entry);
  });

  // GET /api/compliance/audit/log — get audit log
  router.get('/audit/log', requirePermission('read:evidence'), (req, res) => {
    const log = service.getAuditLog({
      actor: req.query.actor as string,
      action: req.query.action as string,
      resource: req.query.resource as string,
      startDate: req.query.startDate as string,
      endDate: req.query.endDate as string,
      limit: boundedLimit(req.query.limit),
    });
    res.json({ entries: log });
  });

  // GET /api/compliance/audit/verify — verify chain integrity
  router.get('/audit/verify', requirePermission('read:evidence'), (_req, res) => {
    res.json(service.verifyChain());
  });

  // POST /api/compliance/reports/generate — generate compliance report
  router.post('/reports/generate', requirePermission('write:governance'), (req, res) => {
    const { type, periodStart, periodEnd } = req.body ?? {};
    if (type !== undefined && !['nora', 'soc2', 'iso27001'].includes(type)) {
      throw createError(400, 'Unsupported report type. Use nora, soc2 or iso27001', 'VALIDATION_ERROR');
    }
    for (const [name, value] of [['periodStart', periodStart], ['periodEnd', periodEnd]] as const) {
      if (value !== undefined && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) {
        throw createError(400, `${name} must be a valid date`, 'VALIDATION_ERROR');
      }
    }
    const report = service.generateReport({ type: type || 'nora', periodStart, periodEnd });
    res.json(report);
  });


  // GET /api/compliance/specs — SDD v1.1.0 spec compliance report
  router.get('/specs', requirePermission('read:evidence'), (req, res) => {
    try {
      res.json(getSpecReport(req.query.refresh === '1'));
    } catch (error) {
      res.status(500).json({ error: { message: 'Failed to scan specs', details: error instanceof Error ? error.message : String(error) } });
    }
  });

  
  // GET /api/compliance/export — export compliance report as JSON or CSV
  router.get('/export', requirePermission('read:evidence'), (req, res) => {
    const format = (req.query.format as string) || 'json';

    if (!['json', 'csv'].includes(format)) {
      res.status(400).json({ error: { message: 'Unsupported format. Use ?format=json or ?format=csv', code: 'VALIDATION_ERROR' } });
      return;
    }

    try {
      const report = getSpecReport();

      if (format === 'csv') {
        const csv = exportReportAsCsv(report);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="compliance-report.csv"');
        res.send(csv);
      } else {
        const json = exportReportAsJson(report);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename="compliance-report.json"');
        res.send(json);
      }
    } catch (error) {
      res.status(500).json({ error: { message: 'Export failed', details: error instanceof Error ? error.message : String(error) } });
    }
  });


  // GET /api/compliance/reports/export — export generated report as JSON/CSV/text
  router.get('/reports/export', requirePermission('read:evidence'), (req, res) => {
    const { type = 'nora', format = 'json', periodStart, periodEnd } = req.query as {
      type?: string;
      format?: string;
      periodStart?: string;
      periodEnd?: string;
    };

    if (!['json', 'csv', 'text'].includes(format)) {
      res.status(400).json({ error: { message: 'Unsupported format. Use ?format=json|csv|text', code: 'VALIDATION_ERROR' } });
      return;
    }
    if (!['nora', 'soc2', 'iso27001'].includes(type)) {
      res.status(400).json({ error: { message: 'Unsupported report type. Use ?type=nora|soc2|iso27001', code: 'VALIDATION_ERROR' } });
      return;
    }

    try {
      const report = service.generateReport({
        type: type as 'nora' | 'soc2' | 'iso27001' | 'custom',
        periodStart,
        periodEnd,
      });

      if (format === 'csv') {
        const csv = service.exportReportAsCsv(report);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="governance-report-${type}.csv"`);
        res.send(csv);
      } else if (format === 'text') {
        const text = service.exportReportAsText(report);
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="governance-report-${type}.txt"`);
        res.send(text);
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="governance-report-${type}.json"`);
        res.json(report);
      }
    } catch (error) {
      res.status(500).json({ error: { message: 'Export failed', details: error instanceof Error ? error.message : String(error) } });
    }
  });

  return router;
}
