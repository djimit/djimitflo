/**
 * SEGML Federation routes — cross-instance governance learning.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { SegmlFederatedGovernanceBridge } from '../services/segml-federated-governance-bridge';

export function createSegmlFederationRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requireAuth = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  // GET /api/segml/federation/summary — federated governance summary
  router.get('/summary', requireAuth('read:evidence'), (_req, res, next) => {
    try {
      const bridge = new SegmlFederatedGovernanceBridge(db);
      res.json(bridge.getSummary());
    } catch (error) {
      next(error);
    }
  });

  // GET /api/segml/federation/sync-history — sync history
  router.get('/sync-history', requireAuth('read:evidence'), (_req, res, next) => {
    try {
      const bridge = new SegmlFederatedGovernanceBridge(db);
      res.json({ history: bridge.getSyncHistory() });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/segml/federation/extract — extract local patterns for sharing
  router.post('/extract', requireAuth('read:evidence'), (_req, res, next) => {
    try {
      const bridge = new SegmlFederatedGovernanceBridge(db);
      res.json({ patterns: bridge.extractLocalPatterns() });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/segml/federation/receive — receive patterns from a peer
  router.post('/receive', requireAuth('read:evidence'), (req, res, next) => {
    try {
      const bridge = new SegmlFederatedGovernanceBridge(db);
      const { peerId, patterns } = req.body;
      if (!peerId || !patterns) {
        res.status(400).json({ error: 'peerId and patterns required' });
        return;
      }
      const result = bridge.receivePeerPatterns(peerId, patterns);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
