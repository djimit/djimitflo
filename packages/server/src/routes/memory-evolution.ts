/**
 * Memory Evolution API routes (FR-003.3).
 *
 * POST /api/v1/memory-evolution/ingest — agents submit traces
 * POST /api/v1/memory-evolution/evolve — scheduler triggers evolution
 * GET  /api/v1/memory-evolution/retrieve — agents pull memories
 * GET  /api/v1/memory-evolution/quality/:id — get quality score
 * POST /api/v1/memory-evolution/promote/:id — evaluate promotion eligibility
 * GET  /api/v1/memory-evolution/leases — list evolution leases
 * POST /api/v1/memory-evolution/leases — create evolution lease
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { MemoryEvolutionService, type EvolutionLeaseRole } from '../services/memory-evolution-service';

export function createMemoryEvolutionRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_permission: string) => (_req: any, _res: any, next: any) => next());
  const service = new MemoryEvolutionService(db);
  const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const leaseRoles = new Set(['memory_evaluator', 'memory_consolidator', 'memory_pruner']);

  // POST /ingest — agent submits a trace for memory creation
  router.post('/ingest', requirePermission('write:evidence'), (req, res) => {
    const { agent_id, content, memory_type, metadata } = req.body;
    if (typeof agent_id !== 'string' || !agent_id.trim() || typeof content !== 'string' || !content.trim()
      || (metadata !== undefined && metadata !== null && !isRecord(metadata))) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'agent_id/content strings and object metadata are required' } });
      return;
    }
    try {
      const candidate = service.ingestTrace({ agentId: agent_id, content, memoryType: memory_type, metadata });
      res.status(201).json({ status: 'ingested', candidate });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // POST /evolve — trigger evolution pipeline
  router.post('/evolve', requirePermission('write:governance'), (req, res) => {
    const { action, candidate_ids, agent_id } = req.body;
    if (!['consolidate', 'prune', 'evaluate'].includes(action)
      || (candidate_ids !== undefined && (!Array.isArray(candidate_ids) || candidate_ids.length > 100 || candidate_ids.some((id: unknown) => typeof id !== 'string' || !id.trim())))
      || (agent_id !== undefined && (typeof agent_id !== 'string' || !agent_id.trim()))) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'action and bounded string candidate_ids are required' } });
      return;
    }
    try {
      const ids = Array.isArray(candidate_ids) ? candidate_ids : [];
      const goals = service.scheduleEvolution(action, ids);
      res.json({ action, status: 'scheduled', candidate_ids: ids, agent_id: agent_id || 'system', goals });
    }
    catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // GET /retrieve — agents pull memories by scope
  router.get('/retrieve', requirePermission('read:evidence'), (req, res) => {
    const agentId = req.query.agent_id as string;
    const scope = req.query.scope as string;
    const requestedLimit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'limit must be an integer between 1 and 100' } });
      return;
    }
    const limit = requestedLimit;
    if (!agentId) { res.status(400).json({ error: 'agent_id query param required' }); return; }
    try {
      const candidateIds = service.retrieveCandidates(agentId, scope || 'all', limit);
      res.json({ agent_id: agentId, scope: scope || 'all', candidates: candidateIds, total: candidateIds.length });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // GET /quality/:id — 6-dimensional quality score
  router.get('/quality/:id', requirePermission('read:evidence'), (req, res) => {
    try { res.json(service.computeQualityScore(req.params.id)); }
    catch (e: any) { res.status(404).json({ error: e.message }); }
  });

  // POST /promote/:id — evaluate promotion eligibility
  router.post('/promote/:id', requirePermission('write:governance'), (req, res) => {
    try { res.json(service.evaluatePromotion(req.params.id)); }
    catch (e: any) { res.status(404).json({ error: e.message }); }
  });

  // GET /leases — list evolution leases
  router.get('/leases', requirePermission('read:evidence'), (req, res) => {
    res.json({ leases: service.listLeases({ role: req.query.role as any, status: req.query.status as any, loopRunId: req.query.loop_run_id as string }) });
  });

  // POST /leases — create evolution lease
  router.post('/leases', requirePermission('write:governance'), (req, res) => {
    const { loop_run_id, role, memory_candidate_id, metadata } = req.body;
    if (typeof loop_run_id !== 'string' || !loop_run_id.trim() || typeof role !== 'string' || !leaseRoles.has(role)
      || (memory_candidate_id !== undefined && memory_candidate_id !== null && (typeof memory_candidate_id !== 'string' || !memory_candidate_id.trim()))
      || (metadata !== undefined && metadata !== null && !isRecord(metadata))) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'loop_run_id, valid role and optional metadata are required' } });
      return;
    }
    try { res.status(201).json(service.createLease({ loopRunId: loop_run_id, role: role as EvolutionLeaseRole, memory_candidate_id: memory_candidate_id, metadata })); }
    catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
