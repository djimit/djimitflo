/**
 * Runtime Governance routes — continuous behavioral monitoring.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { RuntimeGovernanceService } from '../services/runtime-governance-service';

export function createRuntimeGovernanceRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const service = new RuntimeGovernanceService(db);

  // Start monitoring on first request
  service.start();

  // GET /api/runtime-governance/status — overall governance status
  router.get('/status', requirePermission('read:evidence'), (_req, res) => {
    res.json(service.getStatus());
  });

  // GET /api/runtime-governance/alerts — recent governance alerts
  router.get('/alerts', requirePermission('read:evidence'), (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    res.json({ alerts: service.getAlerts(limit) });
  });

  // GET /api/runtime-governance/agents/:agentId — agent governance status
  router.get('/agents/:agentId', requirePermission('read:evidence'), (req, res) => {
    res.json(service.getQuarantineStatus(req.params.agentId));
  });

  // POST /api/runtime-governance/agents/:agentId/register — register baseline
  router.post('/agents/:agentId/register', requirePermission('write:governance'), (req, res) => {
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
    if (!reason?.trim()) {
      res.status(400).json({ error: { message: 'reason is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    service.releaseFromQuarantine(req.params.agentId, reason);
    res.json({ released: true, agentId: req.params.agentId });
  });

  // POST /api/runtime-governance/agents/:agentId/reset — reset circuit breaker
  router.post('/agents/:agentId/reset', requirePermission('write:governance'), (req, res) => {
    service.resetCircuitBreaker(req.params.agentId);
    res.json({ reset: true, agentId: req.params.agentId });
  });

  return router;
}
