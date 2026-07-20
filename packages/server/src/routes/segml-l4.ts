/**
 * SEGML Level 4 routes — Population Evolution + TT-SI + Co-Evolution.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { SegmlLevel4Bridge } from '../services/segml-level4-bridge';

export function createSegmlL4Routes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requireAuth = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  // POST /api/segml/l4/tournament — run tournament round
  router.post('/tournament', requireAuth('write:governance'), (req, res, next) => {
    try {
      const bridge = new SegmlLevel4Bridge(db);
      const matches = bridge.runTournament(req.body?.category);
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
      const { prompt, category } = req.body;
      if (!prompt || !category) {
        res.status(400).json({ error: 'prompt and category required' });
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
      const round = req.body?.round || 1;
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
