/**
 * Self-improvement routes — autonomous coding, test generation, docs.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { AutonomousCoderService } from '../services/autonomous-coder-service';
import { AutonomousTestGeneratorService } from '../services/autonomous-test-generator-service';
import { AutonomousDocsService } from '../services/autonomous-docs-service';
import { ReconciliationService } from '../services/reconciliation-service';

export function createSelfImprovementRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  const coder = new AutonomousCoderService(db);
  const testGen = new AutonomousTestGeneratorService(db);
  const docs = new AutonomousDocsService(db);
  const reconciler = new ReconciliationService(db);

  // POST /api/self-improve/reconcile — re-verify generated claims against source.
  // Body: { claims?: [{title, issueNumber?}], github?: boolean, apply?: boolean }
  // github mode needs GITHUB_REPOSITORY + GITHUB_TOKEN; apply also closes stale issues.
  router.post('/reconcile', requirePermission('write:governance'), async (req, res, next) => {
    try {
      const { claims, github, apply } = req.body || {};
      if (github) {
        res.json(await reconciler.reconcileGitHub({ apply: Boolean(apply) }));
        return;
      }
      if (!Array.isArray(claims) || claims.length === 0 || claims.some((c) => typeof c?.title !== 'string')) {
        res.status(400).json({ error: { message: 'claims must be a non-empty array of {title, issueNumber?}', code: 'VALIDATION_ERROR' } });
        return;
      }
      res.json(reconciler.reconcile(claims, 'api'));
    } catch (error) {
      next(error);
    }
  });

  // GET /api/self-improve/reconciliation — latest reconciliation report
  router.get('/reconciliation', requirePermission('read:evidence'), (_req, res, next) => {
    try {
      const report = reconciler.latestReport();
      if (!report) {
        res.status(404).json({ error: { message: 'No reconciliation runs yet', code: 'NOT_FOUND' } });
        return;
      }
      res.json(report);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/self-improve/scan — scan for improvement opportunities
  router.get('/scan', requirePermission('read:evidence'), (__req, res) => {
    const opportunities = coder.scan();
    res.json({ opportunities, count: opportunities.length });
  });

  // GET /api/self-improve/opportunities — list all opportunities
  router.get('/opportunities', requirePermission('read:evidence'), (_req, res) => {
    res.json({ opportunities: coder.getOpportunities() });
  });

  // POST /api/self-improve/patches — generate patch for opportunity
  router.post('/patches', requirePermission('write:governance'), (req, res) => {
    const { opportunityId } = req.body;
    const patch = coder.generatePatch(opportunityId);
    if (!patch) {
      res.status(404).json({ error: { message: 'Opportunity not found', code: 'NOT_FOUND' } });
      return;
    }
    res.status(201).json(patch);
  });

  // GET /api/self-improve/stats — improvement statistics
  router.get('/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(coder.getStats());
  });

  // GET /api/self-improve/tests/generate — generate tests for untested services
  router.get('/tests/generate', requirePermission('read:evidence'), (_req, res) => {
    const results = testGen.generateAll();
    res.json({ results, count: results.length });
  });

  // POST /api/self-improve/tests/write — write generated tests to disk
  router.post('/tests/write', requirePermission('write:governance'), (_req, res) => {
    const results = testGen.generateAll();
    const written = testGen.writeTests(results);
    res.json({ written, total: results.length });
  });

  // GET /api/self-improve/tests/stats — test coverage statistics
  router.get('/tests/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(testGen.getStats());
  });

  // GET /api/self-improve/docs/scan — scan for undocumented APIs
  router.get('/docs/scan', requirePermission('read:evidence'), (_req, res) => {
    const gaps = docs.scan();
    res.json({ gaps, count: gaps.length });
  });

  // GET /api/self-improve/docs/stats — documentation coverage
  router.get('/docs/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(docs.getStats());
  });

  return router;
}
