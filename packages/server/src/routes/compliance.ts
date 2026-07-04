/**
 * Compliance & Audit routes — immutable evidence chain and compliance reporting.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { ComplianceAuditService } from '../services/compliance-audit-service';

export function createComplianceRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const service = new ComplianceAuditService(db);

  // GET /api/compliance/status — compliance status summary
  router.get('/status', requirePermission('read:evidence'), (_req, res) => {
    res.json(service.getStatus());
  });

  // POST /api/compliance/audit/append — append audit entry
  router.post('/audit/append', requirePermission('write:governance'), (req, res) => {
    const { actor, action, resource, outcome, evidence } = req.body;
    if (!action) {
      res.status(400).json({ error: { message: 'action is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const entry = service.appendEntry({ actor: actor || 'system', action, resource: resource || '', outcome: outcome || 'success', evidence });
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
      limit: req.query.limit ? Number(req.query.limit) : 100,
    });
    res.json({ entries: log });
  });

  // GET /api/compliance/audit/verify — verify chain integrity
  router.get('/audit/verify', requirePermission('read:evidence'), (_req, res) => {
    res.json(service.verifyChain());
  });

  // POST /api/compliance/reports/generate — generate compliance report
  router.post('/reports/generate', requirePermission('write:governance'), (req, res) => {
    const { type, periodStart, periodEnd } = req.body;
    const report = service.generateReport({ type: type || 'nora', periodStart, periodEnd });
    res.json(report);
  });

  return router;
}
