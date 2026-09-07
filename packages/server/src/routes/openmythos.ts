/**
 * OpenMythos evaluation routes.
 *
 * Exposes governance benchmark evaluation, scoring, and reporting.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { createError } from '../middleware/error-handler';
import { OpenMythosEvalService } from '../services/openmythos-eval-service';
import { GovernanceGuardService } from '../services/governance-guard-service';
import { ApexReportService } from '../services/apex-report-service';
import { OpenMythosAttestationService } from '../services/openmythos-attestation-service';
import { WorldLabEvidenceService } from '../services/worldlab-evidence-service';

export function createOpenMythosRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const evalService = new OpenMythosEvalService(db);
  const guardService = new GovernanceGuardService(db);
  const attestations = new OpenMythosAttestationService(db);
  const worldLabEvidence = new WorldLabEvidenceService(db);

  router.post('/worldlab/retests', requirePermission('write:governance'), (req, res, next) => {
    try { res.status(201).json(worldLabEvidence.recordRetest(req.body)); }
    catch (error) {
      const code = error instanceof Error ? error.message : 'WORLDLAB_RETEST_INVALID';
      next(createError(code.endsWith('_NOT_FOUND') ? 404 : code.endsWith('_MISMATCH') ? 409 : 400,
        'WorldLab retest evidence rejected', code));
    }
  });

  router.post('/attestations', requirePermission('write:governance'), (req, res, next) => {
    try {
      res.status(201).json(attestations.import(req.body, req.user?.sub || req.user?.email || 'authenticated-operator'));
    } catch (error) {
      const code = error instanceof Error ? error.message : 'OPENMYTHOS_ATTESTATION_INVALID';
      next(createError(code.endsWith('_NOT_FOUND') ? 404 : code.endsWith('_INCOMPLETE') || code.endsWith('_MISMATCH') ? 409 : 400,
        'OpenMythos attestation rejected', code));
    }
  });

  router.get('/attestations', requirePermission('read:evidence'), (req, res, next) => {
    try { res.json({ attestations: attestations.list(Number(req.query.limit) || 50) }); }
    catch (error) { next(error); }
  });

  router.get(['/status', '/status/:agentId'], requirePermission('read:evidence'), (req, res, next) => {
    try {
      res.json(evalService.getOperationalStatus(req.params.agentId));
    } catch (error) {
      next(error);
    }
  });

  // POST /api/openmythos/eval/:agentId — start evaluation run
  router.post('/eval/:agentId', requirePermission('write:governance'), async (req, res, next) => {
    try {
      const { categories, model, case_ids: caseIds } = req.body || {};
      if (caseIds !== undefined && (!Array.isArray(caseIds) || caseIds.length > 500 || caseIds.some((id) => typeof id !== 'string' || !id.trim()))) {
        throw createError(400, 'case_ids must be an array of at most 500 non-empty strings', 'VALIDATION_ERROR');
      }
      const result = await evalService.runEval(req.params.agentId, categories, model, caseIds);
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/openmythos/runs — recent eval runs across all agents
  router.get('/runs', requirePermission('read:evidence'), (req, res, next) => {
    try {
      const limit = req.query.limit ? Math.min(Math.max(Number(req.query.limit) || 20, 1), 100) : 20;
      res.json({ runs: evalService.listRuns(limit) });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/openmythos/leaderboard — latest score per agent, best first
  router.get('/leaderboard', requirePermission('read:evidence'), (_req, res, next) => {
    try {
      res.json({ leaderboard: evalService.getLeaderboard() });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/openmythos/score/:agentId — get latest scores
  router.get('/score/:agentId', requirePermission('read:evidence'), (req, res, next) => {
    try {
      const score = evalService.getAgentScore(req.params.agentId);
      if (!score) {
        throw createError(404, 'No evaluation data for this agent', 'OPENMYTHOS_NO_DATA');
      }
      res.json(score);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/openmythos/report/:agentId — generate governance report
  router.get('/report/:agentId', requirePermission('read:evidence'), (req, res, next) => {
    try {
      const report = evalService.generateReport(req.params.agentId);
      res.json(report);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/openmythos/trend/:agentId — governance trend over time
  router.get('/trend/:agentId', requirePermission('read:evidence'), (req, res, next) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 10;
      const trend = evalService.getGovernanceTrend(req.params.agentId, limit);
      res.json({ agentId: req.params.agentId, trend });
    } catch (error) {
      next(error);
    }
  });

  const apexReports = new ApexReportService();

  // GET /api/openmythos/apex/reports — APEX research round index
  router.get('/apex/reports', requirePermission('read:evidence'), (_req, res, next) => {
    try {
      res.json({ reports: apexReports.list() });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/openmythos/apex/reports/:round — all reports for one round, with bodies
  router.get('/apex/reports/:round', requirePermission('read:evidence'), (req, res, next) => {
    try {
      const round = Number(req.params.round);
      if (!Number.isInteger(round) || round < 0) {
        throw createError(400, 'round must be a non-negative integer', 'VALIDATION_ERROR');
      }
      const reports = apexReports.get(round);
      if (reports.length === 0) {
        throw createError(404, `No APEX reports for round ${round}`, 'NOT_FOUND');
      }
      res.json({ round, reports });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/openmythos/guard/check/:skillId — run governance guard check
  router.post('/guard/check/:skillId', requirePermission('write:governance'), async (req, res, next) => {
    try {
      const result = await guardService.runBenchmarkCheck(req.params.skillId, req.body?.metadata);
      res.json(result);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('SKILL_NOT_ADMITTED:')) {
        next(createError(404, 'Skill is not admitted', 'SKILL_NOT_ADMITTED'));
        return;
      }
      next(error);
    }
  });

  // GET /api/openmythos/guard/certified/:skillId — check certification status
  router.get('/guard/certified/:skillId', requirePermission('read:evidence'), (req, res, next) => {
    try {
      const certified = guardService.isGovernanceCertified(req.params.skillId);
      const score = guardService.getLatestScore(req.params.skillId);
      res.json({ skillId: req.params.skillId, certified, score });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
