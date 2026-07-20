/**
 * SEGML Literature Scan routes — autonomous paper-literature scan.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { SegmlLiteratureScanBridge } from '../services/segml-literature-scan-bridge';

export function createSegmlLiteratureRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requireAuth = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  // POST /api/segml/literature/scan — trigger a literature scan
  router.post('/scan', requireAuth('write:governance'), async (_req, res, next) => {
    try {
      const bridge = new SegmlLiteratureScanBridge(db);
      const result = await bridge.scanForNewCategories();
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/segml/literature/proposed — get proposed categories
  router.get('/proposed', requireAuth('read:evidence'), (req, res, next) => {
    try {
      const bridge = new SegmlLiteratureScanBridge(db);
      const status = req.query.status as string | undefined;
      res.json({ categories: bridge.getProposedCategories(status) });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/segml/literature/approve/:id — approve a proposed category
  router.post('/approve/:id', requireAuth('write:governance'), (req, res, next) => {
    try {
      const bridge = new SegmlLiteratureScanBridge(db);
      const approved = bridge.approveCategory(req.params.id);
      res.json({ approved });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/segml/literature/status — scan status
  router.get('/status', requireAuth('read:evidence'), (_req, res, next) => {
    try {
      const bridge = new SegmlLiteratureScanBridge(db);
      res.json(bridge.getStatus());
    } catch (error) {
      next(error);
    }
  });

  return router;
}
