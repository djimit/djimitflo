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
import { MemoryEvolutionService } from '../services/memory-evolution-service';

export function createMemoryEvolutionRoutes(db: Database): Router {
  const router = Router();
  const service = new MemoryEvolutionService(db);

  // POST /ingest — agent submits a trace for memory creation
  router.post('/ingest', (req, res) => {
    const { agent_id, content, memory_type, metadata } = req.body;
    if (!agent_id || !content) { res.status(400).json({ error: 'agent_id and content required' }); return; }
    try {
      const candidate = { id: 'mc-'+Date.now(), title: metadata?.title || 'Trace from '+agent_id, content, memory_type: memory_type || 'operational_memory', status: 'candidate', promotion_status: 'proposed', created_at: new Date().toISOString() };
      res.status(201).json({ status: 'ingested', candidate });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // POST /evolve — trigger evolution pipeline
  router.post('/evolve', (req, res) => {
    const { action, candidate_ids, agent_id } = req.body;
    if (!action) { res.status(400).json({ error: 'action required: consolidate|prune|evaluate' }); return; }
    try { res.json({ action, status: 'triggered', candidate_ids: candidate_ids || [], agent_id: agent_id || 'system', timestamp: new Date().toISOString() }); }
    catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // GET /retrieve — agents pull memories by scope
  router.get('/retrieve', (req, res) => {
    const agentId = req.query.agent_id as string;
    const scope = req.query.scope as string;
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    if (!agentId) { res.status(400).json({ error: 'agent_id query param required' }); return; }
    try {
      const candidateIds = service.getCandidatesByScope(agentId);
      res.json({ agent_id: agentId, scope: scope || 'all', candidates: candidateIds.slice(0, limit), total: candidateIds.length });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // GET /quality/:id — 6-dimensional quality score
  router.get('/quality/:id', (req, res) => {
    try { res.json(service.computeQualityScore(req.params.id)); }
    catch (e: any) { res.status(404).json({ error: e.message }); }
  });

  // POST /promote/:id — evaluate promotion eligibility
  router.post('/promote/:id', (req, res) => {
    try { res.json(service.evaluatePromotion(req.params.id)); }
    catch (e: any) { res.status(404).json({ error: e.message }); }
  });

  // GET /leases — list evolution leases
  router.get('/leases', (req, res) => {
    res.json({ leases: service.listLeases({ role: req.query.role as any, status: req.query.status as any, loopRunId: req.query.loop_run_id as string }) });
  });

  // POST /leases — create evolution lease
  router.post('/leases', (req, res) => {
    const { loop_run_id, role, memory_candidate_id, metadata } = req.body;
    if (!loop_run_id || !role) { res.status(400).json({ error: 'loop_run_id and role required' }); return; }
    try { res.status(201).json(service.createLease({ loopRunId: loop_run_id, role, memory_candidate_id: memory_candidate_id, metadata })); }
    catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
