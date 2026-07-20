/**
 * SEGML routes — Self-Evolving Governance Memory Loop API.
 *
 * Exposes cycle execution, history, blind spots, generated cases,
 * and judge rubric weights.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { createError } from '../middleware/error-handler';
import { SelfEvolvingGovernanceLoop } from '../services/self-evolving-governance-loop';

export function createSegmlRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  // POST /api/segml/run/:agentId — trigger a self-evolution cycle
  router.post('/run/:agentId', requirePermission('write:governance'), async (req, res, next) => {
    try {
      const loop = new SelfEvolvingGovernanceLoop(db, req.body?.config);
      const result = await loop.runCycle(req.params.agentId);
      res.status(result.status === 'completed' ? 200 : 202).json(result);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/segml/history — cycle history
  router.get('/history', requirePermission('read:evidence'), (req, res, next) => {
    try {
      const loop = new SelfEvolvingGovernanceLoop(db);
      const limit = req.query.limit ? Math.min(100, Number(req.query.limit)) : 20;
      res.json({ cycles: loop.getCycleHistory(limit) });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/segml/latest — latest cycle result
  router.get('/latest', requirePermission('read:evidence'), (_req, res, next) => {
    try {
      const loop = new SelfEvolvingGovernanceLoop(db);
      const latest = loop.getLatestCycle();
      if (!latest) throw createError(404, 'No SEGML cycles found', 'SEGML_NO_CYCLES');
      res.json(latest);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/segml/blind-spots/:agentId — current blind spots from latest eval
  router.get('/blind-spots/:agentId', requirePermission('read:evidence'), (_req, res, next) => {
    try {
      const loop = new SelfEvolvingGovernanceLoop(db);
      const latest = loop.getLatestCycle();
      if (!latest) throw createError(404, 'No cycle data available', 'SEGML_NO_DATA');
      res.json({ blind_spots: latest.blind_spots_detected, score_delta: latest.score_delta });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/segml/generated-cases — generated training cases
  router.get('/generated-cases', requirePermission('read:evidence'), (req, res, next) => {
    try {
      const cycleId = req.query.cycle_id as string | undefined;
      let query = 'SELECT * FROM segml_generated_cases';
      const params: string[] = [];
      if (cycleId) {
        query += ' WHERE cycle_id = ?';
        params.push(cycleId);
      }
      query += ' ORDER BY created_at DESC LIMIT 100';
      const cases = db.prepare(query).all(...params);
      res.json({ cases, count: (cases as any[]).length });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/segml/judge-rubrics — current judge rubric weights
  router.get('/judge-rubrics', requirePermission('read:evidence'), (_req, res, next) => {
    try {
      const updater = new (require('../services/segml-judge-updater').SegmlJudgeUpdater)(db);
      res.json({ rubrics: updater.getRubricWeights() });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/segml/curriculum — current curriculum phases
  router.get('/curriculum', requirePermission('read:evidence'), (_req, res, next) => {
    try {
      const adapter = new (require('../services/segml-curriculum-adapter').SegmlCurriculumAdapter)(db);
      res.json({ phases: adapter.getPhases() });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
