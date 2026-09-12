/**
 * SEGML Level 4 routes — Population Evolution + TT-SI + Co-Evolution.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { SegmlLevel4Bridge } from '../services/segml-level4-bridge';

const L4_CATEGORIES = new Set(['injection', 'hallucination', 'calibration', 'overthinking', 'contradiction', 'tool-scope']);
const isCategory = (value: unknown): value is string => typeof value === 'string' && L4_CATEGORIES.has(value);
const isRound = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1_000_000;

export function createSegmlL4Routes(db: Database, auth: AuthMiddleware): Router {
  const router = Router();
  const requireAuth = auth.requirePermission;

  // POST /api/segml/l4/tournament — run tournament round
  router.post('/tournament', requireAuth('write:governance'), (req, res, next) => {
    try {
      const category = req.body?.category;
      if (category !== undefined && !isCategory(category)) {
        res.status(400).json({ error: { message: 'category must be a supported governance category', code: 'VALIDATION_ERROR' } });
        return;
      }
      const bridge = new SegmlLevel4Bridge(db);
      const matches = bridge.runTournament(category);
      res.json({ matches, count: matches.length });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/segml/l4/evolve — evolve population
  router.post('/evolve', requireAuth('write:governance'), (_req, res, next) => {
    try {
      const bridge = new SegmlLevel4Bridge(db);
      const result = bridge.evolvePopulation();
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/segml/l4/ttsi — apply test-time self-improvement
  router.post('/ttsi', requireAuth('write:governance'), (req, res, next) => {
    try {
      const bridge = new SegmlLevel4Bridge(db);
      const { prompt, category } = req.body ?? {};
      if (typeof prompt !== 'string' || !prompt.trim() || !isCategory(category)) {
        res.status(400).json({ error: { message: 'prompt and category are required', code: 'VALIDATION_ERROR' } });
        return;
      }
      const result = bridge.applyTTSI(prompt, category);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/segml/l4/coevolution — run co-evolutionary round
  router.post('/coevolution', requireAuth('write:governance'), (req, res, next) => {
    try {
      const bridge = new SegmlLevel4Bridge(db);
      const round = req.body?.round ?? 1;
      if (!isRound(round)) {
        res.status(400).json({ error: { message: 'round must be a positive integer', code: 'VALIDATION_ERROR' } });
        return;
      }
      const results = bridge.runCoEvolutionRound(round);
      res.json({ round, results, attacks: results.length });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/segml/l4/status — Level 4 status
  router.get('/status', requireAuth('read:evidence'), (_req, res, next) => {
    try {
      const bridge = new SegmlLevel4Bridge(db);
      res.json(bridge.getStatus());
    } catch (error) {
      next(error);
    }
  });

  return router;
}
