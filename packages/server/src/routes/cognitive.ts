/**
 * Cognitive Loop Closure routes — cross-episode learning and strategy evolution.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { CognitiveLoopClosureService } from '../services/cognitive-loop-closure-service';

export function createCognitiveRoutes(
  db: Database,
  auth?: AuthMiddleware,
  service = new CognitiveLoopClosureService(db),
): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  service.start();

  // GET /api/cognitive/stats — cognitive loop statistics
  router.get('/stats', requirePermission('read:evidence'), (__req, res) => {
    res.json(service.getStats());
  });

  // GET /api/cognitive/meta-learning — meta-learning status per goal type
  router.get('/meta-learning', requirePermission('read:evidence'), (__req, res) => {
    res.json({ records: service.getMetaLearningStatus() });
  });

  // GET /api/cognitive/strategy/:goalType — best strategy for a goal type
  router.get('/strategy/:goalType', requirePermission('read:evidence'), (req, res) => {
    const strategy = service.getBestStrategy(req.params.goalType);
    if (!strategy) {
      res.json({ message: 'No learned strategy yet for this goal type. Need ≥3 episodes.' });
      return;
    }
    res.json(strategy);
  });

  // POST /api/cognitive/episodes — record a manual episode
  router.post('/episodes', requirePermission('write:governance'), (req, res) => {
    const input = req.body || {};
    const loopRunId = input.loopRunId ?? input.loop_run_id;
    if (typeof loopRunId !== 'string' || !loopRunId.trim()) {
      res.status(400).json({ error: { message: 'loopRunId is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const outcome = input.outcome || 'partial';
    if (!['success', 'failure', 'partial', 'cancelled'].includes(outcome)) {
      res.status(400).json({ error: { message: 'outcome is invalid', code: 'VALIDATION_ERROR' } });
      return;
    }
    const now = new Date().toISOString();
    const episode = service.recordEpisode({
      loopRunId: loopRunId.trim(), goalId: String(input.goalId ?? input.goal_id ?? ''),
      goalType: String(input.goalType ?? input.goal_type ?? 'general'), mode: String(input.mode ?? 'closed'),
      startedAt: String(input.startedAt ?? input.started_at ?? now), completedAt: String(input.completedAt ?? input.completed_at ?? now),
      durationMs: Number(input.durationMs ?? input.duration_ms ?? 0), outcome,
      strategy: String(input.strategy ?? 'default'), actions: Array.isArray(input.actions) ? input.actions : [],
      metrics: input.metrics && typeof input.metrics === 'object' ? input.metrics : {},
      metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    });
    res.status(201).json(episode);
  });

  // POST /api/cognitive/extract-patterns — trigger pattern extraction
  router.post('/extract-patterns', requirePermission('write:governance'), (__req, res) => {
    const patterns = service.extractPatterns();
    res.json({ patternsExtracted: patterns.length, patterns });
  });

  // POST /api/cognitive/evolve-strategies — trigger strategy evolution
  router.post('/evolve-strategies', requirePermission('write:governance'), (__req, res) => {
    const strategies = service.evolveStrategies();
    res.json({ strategiesEvolved: strategies.length, strategies });
  });

  return router;
}
