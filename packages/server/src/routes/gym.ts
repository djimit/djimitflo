/**
 * Skill Evolution Gym routes — governance curriculum and evaluation.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { SkillEvolutionGym } from '../services/skill-evolution-gym';
import { GymGovernanceCurriculum } from '../services/gym-governance-curriculum';
import { createError } from '../middleware/error-handler';

export function createGymRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const gym = new SkillEvolutionGym(db);
  const curriculum = new GymGovernanceCurriculum(db);

  function boundedLimit(value: unknown): number {
    if (value === undefined) return 10;
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw createError(400, 'limit must be an integer between 1 and 100', 'VALIDATION_ERROR');
    }
    return limit;
  }

  // GET /api/gym/governance/:skillId — governance status
  router.get('/governance/:skillId', requirePermission('read:evidence'), (req, res, next) => {
    try {
      const status = curriculum.getSkillStatus(req.params.skillId);
      res.json(status);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/gym/governance/:skillId/run — trigger governance evaluation
  router.post('/governance/:skillId/run', requirePermission('write:governance'), async (req, res, next) => {
    try {
      const { phase, categories, model } = req.body || {};
      let result;

      if (phase) {
        result = await curriculum.runPhaseEvaluation(req.params.skillId, phase, model);
      } else if (categories) {
        result = await gym.runGovernanceEvaluation(req.params.skillId, categories, model);
      } else {
        // Run full curriculum
        result = await curriculum.runFullCurriculum({
          id: req.params.skillId,
          autonomy_level: req.body?.autonomy_level,
          risk_class: req.body?.risk_class,
          complexity: req.body?.complexity,
          model,
        });
      }

      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/gym/governance/:skillId/history — governance evaluation history
  router.get('/governance/:skillId/history', requirePermission('read:evidence'), (req, res, next) => {
    try {
      const history = gym.getGovernanceHistory(req.params.skillId, boundedLimit(req.query.limit));
      res.json({ skillId: req.params.skillId, history });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/gym/governance/:skillId/retest — re-test after skill update
  router.post('/governance/:skillId/retest', requirePermission('write:governance'), async (req, res, next) => {
    try {
      const result = await curriculum.retestSkill({
        id: req.params.skillId,
        autonomy_level: req.body?.autonomy_level,
        risk_class: req.body?.risk_class,
        complexity: req.body?.complexity,
        model: req.body?.model,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/gym/governance/:skillId/curriculum — get applicable curriculum
  router.get('/governance/:skillId/curriculum', requirePermission('read:evidence'), (req, res, next) => {
    try {
      const phases = curriculum.getCurriculumForSkill({
        autonomy_level: req.query.autonomy_level as string,
        risk_class: req.query.risk_class as string,
        complexity: req.query.complexity as string,
      });
      res.json({ skillId: req.params.skillId, phases });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
