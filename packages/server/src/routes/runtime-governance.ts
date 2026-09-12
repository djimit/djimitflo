/**
 * Runtime Governance routes — continuous behavioral monitoring.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { RuntimeGovernanceService } from '../services/runtime-governance-service';
import { createError } from '../middleware/error-handler';

function boundedLimit(value: unknown, fallback = 50): number {
  if (value === undefined) return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw createError(400, 'limit must be an integer between 1 and 500', 'VALIDATION_ERROR');
  }
  return limit;
}

function isGovernanceScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10;
}

export function createRuntimeGovernanceRoutes(
  db: Database,
  auth?: AuthMiddleware,
  service = new RuntimeGovernanceService(db),
): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  // Start monitoring on first request
  service.start();

  // GET /api/runtime-governance/status — overall governance status
  router.get('/status', requirePermission('read:evidence'), (_req, res) => {
    res.json(service.getStatus());
  });

  // GET /api/runtime-governance/alerts — recent governance alerts
  router.get('/alerts', requirePermission('read:evidence'), (req, res) => {
    const limit = boundedLimit(req.query.limit);
    res.json({ alerts: service.getAlerts(limit) });
  });

  // GET /api/runtime-governance/agents/:agentId — agent governance status
  router.get('/agents/:agentId', requirePermission('read:evidence'), (req, res) => {
    res.json(service.getQuarantineStatus(req.params.agentId));
  });

  // POST /api/runtime-governance/agents/:agentId/register — register baseline
  router.post('/agents/:agentId/register', requirePermission('write:governance'), (req, res) => {
    const { overallScore, categoryScores, certifiedAt } = req.body ?? {};
    const validCategoryScores = categoryScores !== null
      && typeof categoryScores === 'object'
      && !Array.isArray(categoryScores)
      && Object.values(categoryScores as Record<string, unknown>).every(isGovernanceScore);
    if (!isGovernanceScore(overallScore) || !validCategoryScores || typeof certifiedAt !== 'string' || !certifiedAt.trim()) {
      res.status(400).json({ error: { message: 'scores must be between 0 and 10, and certifiedAt is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    service.registerBaseline(req.params.agentId, req.body);
    res.json({ registered: true, agentId: req.params.agentId });
  });

  // POST /api/runtime-governance/agents/:agentId/check — check if allowed
  router.post('/agents/:agentId/check', requirePermission('read:evidence'), (req, res) => {
    const allowed = service.isAllowed(req.params.agentId);
    const status = service.getQuarantineStatus(req.params.agentId);
    res.json({ agentId: req.params.agentId, allowed, ...status });
  });

  // POST /api/runtime-governance/agents/:agentId/release — release from quarantine
  router.post('/agents/:agentId/release', requirePermission('write:governance'), (req, res) => {
    const { reason } = req.body || {};
    if (typeof reason !== 'string' || !reason.trim()) {
      res.status(400).json({ error: { message: 'reason is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    try {
      service.releaseFromQuarantine(req.params.agentId, reason.trim());
      res.json({ released: true, agentId: req.params.agentId });
    } catch (error) {
      if (error instanceof Error && /^Agent not found:/.test(error.message)) {
        res.status(404).json({ error: { message: error.message, code: 'AGENT_NOT_FOUND' } });
        return;
      }
      throw error;
    }
  });

  // POST /api/runtime-governance/agents/:agentId/reset — reset circuit breaker
  router.post('/agents/:agentId/reset', requirePermission('write:governance'), (req, res) => {
    try {
      service.resetCircuitBreaker(req.params.agentId);
      res.json({ reset: true, agentId: req.params.agentId });
    } catch (error) {
      if (error instanceof Error && /^Agent not found:/.test(error.message)) {
        res.status(404).json({ error: { message: error.message, code: 'AGENT_NOT_FOUND' } });
        return;
      }
      throw error;
    }
  });

  return router;
}
