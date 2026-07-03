/**
 * Worker pool, scheduler, and handoff routes.
 *
 * Extracted from swarms.ts (Phase B3 decomposition).
 * Handles: worker pool management, scheduler ticks, backlog sync, agent handoffs.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { createError } from '../middleware/error-handler';
import type { AuthMiddleware } from '../middleware/auth';
import { SwarmStatusService } from '../services/swarm-status-service';

function mapWorkerPoolError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'WORKER_LEASE_NOT_FOUND') throw createError(404, 'Worker lease not found', 'WORKER_LEASE_NOT_FOUND');
  if (message === 'WORKER_LEASE_NOT_STOPPABLE') throw createError(409, 'Worker lease is not stoppable', 'WORKER_LEASE_NOT_STOPPABLE');
  throw error;
}

function mapHandoffError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'SWARM_HANDOFF_REQUIRED') throw createError(400, 'from_agent_id, to_agent_id and summary are required', 'SWARM_HANDOFF_REQUIRED');
  if (message === 'SWARM_HANDOFF_SOURCE_REQUIRED') throw createError(400, 'source_lease_id, work_item_id or task_id is required', 'SWARM_HANDOFF_SOURCE_REQUIRED');
  if (message === 'SWARM_HANDOFF_PRIORITY_INVALID') throw createError(400, 'handoff priority is invalid', 'SWARM_HANDOFF_PRIORITY_INVALID');
  if (message === 'SWARM_HANDOFF_NOT_FOUND') throw createError(404, 'handoff not found', 'SWARM_HANDOFF_NOT_FOUND');
  if (message === 'SWARM_HANDOFF_INVALID') throw createError(400, 'message is not a swarm handoff', 'SWARM_HANDOFF_INVALID');
  if (message === 'SWARM_HANDOFF_ALREADY_ACCEPTED') throw createError(409, 'handoff is already accepted', 'SWARM_HANDOFF_ALREADY_ACCEPTED');
  if (message === 'SWARM_HANDOFF_AGENT_NOT_FOUND') throw createError(404, 'handoff agent not found', 'SWARM_HANDOFF_AGENT_NOT_FOUND');
  if (message === 'SWARM_HANDOFF_LEASE_NOT_FOUND') throw createError(404, 'handoff source lease not found', 'SWARM_HANDOFF_LEASE_NOT_FOUND');
  if (message === 'SWARM_HANDOFF_WORK_ITEM_NOT_FOUND') throw createError(404, 'handoff work item not found', 'SWARM_HANDOFF_WORK_ITEM_NOT_FOUND');
  if (message === 'SWARM_HANDOFF_TASK_NOT_FOUND') throw createError(404, 'handoff task not found', 'SWARM_HANDOFF_TASK_NOT_FOUND');
  throw error;
}

export function createWorkerRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const service = new SwarmStatusService(db);

  router.post('/scheduler/tick', requirePermission('write:swarm_action'), (req, res, next) => {
    try { res.json(service.tickScheduler(req.body || {})); } catch (error) { next(error); }
  });

  router.post('/backlog/sync', requirePermission('write:swarm_action'), (req, res, next) => {
    try { res.json(service.syncBacklogFromFleet(req.body || {})); } catch (error) { next(error); }
  });

  router.post('/worker-pool/plan', requirePermission('read:evidence'), (req, res, next) => {
    try { res.json(service.planWorkerPool(req.body || {})); } catch (error) { try { mapWorkerPoolError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.post('/worker-pool/start-next', requirePermission('write:swarm_action'), async (req, res, next) => {
    try { res.json(await service.startNextWorker(req.body || {})); } catch (error) { try { mapWorkerPoolError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.post('/worker-pool/drain', requirePermission('write:swarm_action'), async (req, res, next) => {
    try { res.json(await service.drainWorkerPool(req.body || {})); } catch (error) { try { mapWorkerPoolError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.post('/worker-pool/stop/:leaseId', requirePermission('write:swarm_action'), (req, res, next) => {
    try { res.json(service.stopWorkerLease(req.params.leaseId)); } catch (error) { try { mapWorkerPoolError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.post('/handoffs', requirePermission('write:swarm_action'), async (req, res, next) => {
    try { res.status(201).json(await service.createHandoff(req.body || {})); } catch (error) { try { mapHandoffError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.post('/handoffs/drain', requirePermission('write:swarm_action'), async (req, res, next) => {
    try { res.json(await service.drainHandoffs(req.body || {})); } catch (error) { try { mapHandoffError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.post('/handoffs/:id/accept', requirePermission('write:swarm_action'), (req, res, next) => {
    try { res.json(service.acceptHandoff(req.params.id)); } catch (error) { try { mapHandoffError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  return router;
}
