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

export function createOpenMythosRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const evalService = new OpenMythosEvalService(db);
  const guardService = new GovernanceGuardService(db);

  // POST /api/openmythos/eval/:agentId — start evaluation run
  router.post('/eval/:agentId', requirePermission('write:governance'), async (req, res, next) => {
    try {
      const { categories, model } = req.body || {};
      const result = await evalService.runEval(req.params.agentId, categories, model);
      res.status(201).json(result);
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

  // POST /api/openmythos/guard/check/:skillId — run governance guard check
  router.post('/guard/check/:skillId', requirePermission('write:governance'), async (req, res, next) => {
    try {
      const result = await guardService.runBenchmarkCheck(req.params.skillId, req.body?.metadata);
      res.json(result);
    } catch (error) {
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
