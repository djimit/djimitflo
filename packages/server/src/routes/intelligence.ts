/**
 * Intelligence routes — predictive analytics + self-healing.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { PredictiveAnalyticsService } from '../services/predictive-analytics-service';
import { SelfHealingService } from '../services/self-healing-service';

export function createIntelligenceRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  const predictive = new PredictiveAnalyticsService(db);
  const healing = new SelfHealingService(db);

  // ─── Predictive Analytics ────────────────────────────────────────────
  router.post('/predict', requirePermission('read:evidence'), (req, res) => {
    const { goalType, runtime, mode, estimatedFindings } = req.body;
    res.json(predictive.predict({ goalType, runtime, mode, estimatedFindings }));
  });

  router.get('/patterns', requirePermission('read:evidence'), (_req, res) => {
    res.json({ patterns: predictive.analyzePatterns() });
  });

  router.get('/predictive/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(predictive.getStats());
  });

  // Data Quality
  router.get('/data-quality', requirePermission('read:evidence'), (_req, res) => {
    res.json(predictive.checkDataQuality());
  });

  // ─── Self-Healing ───────────────────────────────────────────────────
  router.get('/health', requirePermission('read:evidence'), (_req, res) => {
    res.json({ checks: healing.checkHealth() });
  });

  router.post('/heal', requirePermission('write:governance'), (_req, res) => {
    res.json(healing.heal());
  });

  router.get('/incidents', requirePermission('read:evidence'), (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    res.json({ incidents: healing.getIncidents(limit) });
  });

  router.get('/healing/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(healing.getStats());
  });

  return router;
}
