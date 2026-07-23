/**
 * Compliance & Audit routes — immutable evidence chain and compliance reporting.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { ComplianceAuditService } from '../services/compliance-audit-service';
import { generateComplianceReport } from '../services/spec-compliance-service';

export function createComplianceRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const service = new ComplianceAuditService(db);

  // GET /api/compliance/status — compliance status summary
  router.get('/status', requirePermission('read:evidence'), (_req, res) => {
    res.json(service.getStatus());
  });

  // POST /api/compliance/audit/append — append audit entry
  // SECURITY: actor is derived from authenticated principal, never from request body.
  // This prevents audit trail spoofing where a user could impersonate another actor.
  router.post('/audit/append', requirePermission('write:governance'), (req, res) => {
    const { action, resource, outcome, evidence } = req.body;
    if (!action) {
      res.status(400).json({ error: { message: 'action is required', code: 'VALIDATION_ERROR' } });
      return;
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


  // GET /api/compliance/specs — SDD v1.1.0 spec compliance report
  router.get('/specs', requirePermission('read:evidence'), (_req, res) => {
    try {
      const fs = require('fs');
      const path = require('path');
      const specsDir = path.resolve(process.cwd(), 'specs');
      const archiveDir = path.resolve(process.cwd(), 'specs/archive');

      const specs: Array<{ name: string; path: string; content: string }> = [];

      // Scan specs/ directory
      for (const dir of [specsDir, archiveDir]) {
        if (!fs.existsSync(dir)) continue;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const specFile = path.join(dir, entry.name, 'spec.md');
            if (fs.existsSync(specFile)) {
              const content = fs.readFileSync(specFile, 'utf-8');
              specs.push({ name: entry.name, path: specFile, content });
            }
          }
        }
      }

      const report = generateComplianceReport(specs);
      res.json(report);
    } catch (error) {
      res.status(500).json({ error: { message: 'Failed to scan specs', details: error instanceof Error ? error.message : String(error) } });
    }
  });

    return router;
}
