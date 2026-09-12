/**
 * Intelligence routes — predictive analytics + self-healing.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { PredictiveAnalyticsService } from '../services/predictive-analytics-service';
import { SelfHealingService } from '../services/self-healing-service';
import { createError } from '../middleware/error-handler';

function boundedLimit(value: unknown, fallback = 50): number {
  if (value === undefined) return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw createError(400, 'limit must be an integer between 1 and 500', 'VALIDATION_ERROR');
  }
  return limit;
}

export function createIntelligenceRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  const predictive = new PredictiveAnalyticsService(db);
  const healing = new SelfHealingService(db);

  // ─── Predictive Analytics ────────────────────────────────────────────
  router.post('/predict', requirePermission('read:evidence'), (req, res) => {
    const { goalType, runtime, mode, estimatedFindings } = req.body;
    if (typeof goalType !== 'string' || !goalType.trim()
      || typeof runtime !== 'string' || !runtime.trim()
      || typeof mode !== 'string' || !mode.trim()
      || (estimatedFindings !== undefined
        && (!Number.isInteger(estimatedFindings) || estimatedFindings < 0 || estimatedFindings > 1_000_000))) {
      throw createError(400, 'goalType, runtime and mode must be non-empty strings; estimatedFindings must be a nonnegative integer', 'VALIDATION_ERROR');
    }
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
    const limit = boundedLimit(req.query.limit);
    res.json({ incidents: healing.getIncidents(limit) });
  });

  router.get('/healing/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(healing.getStats());
  });

  return router;
}
