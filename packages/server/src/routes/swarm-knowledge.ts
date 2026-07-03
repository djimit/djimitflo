/**
 * Knowledge routes — OKF knowledge runtime, capabilities sync, runtime readiness.
 *
 * Extracted from swarms.ts (Phase B3 decomposition).
 * Handles: knowledge runtime health, capability sync, runtime readiness checks.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { createError } from '../middleware/error-handler';
import type { AuthMiddleware } from '../middleware/auth';
import { KnowledgeRuntimeService } from '../services/knowledge-runtime-service';
import { LoopService } from '../services/loop-service';

function mapKnowledgeRuntimeError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'KNOWLEDGE_RUNTIME_OKF_BASE_MISSING') throw createError(404, 'Canonical OKF base is missing', 'KNOWLEDGE_RUNTIME_OKF_BASE_MISSING');
  if (message === 'KNOWLEDGE_RUNTIME_PACKAGES_KNOWLEDGE_NOT_CANONICAL') throw createError(409, 'packages/knowledge is not the canonical runtime OKF base', 'KNOWLEDGE_RUNTIME_PACKAGES_KNOWLEDGE_NOT_CANONICAL');
  if (message === 'KNOWLEDGE_RUNTIME_OKF_VALIDATION_FAILED') throw createError(422, 'OKF validation failed', 'KNOWLEDGE_RUNTIME_OKF_VALIDATION_FAILED');
  if (message === 'KNOWLEDGE_RUNTIME_LOOP_RUN_REQUIRED') throw createError(400, 'loop_run_id is required', 'KNOWLEDGE_RUNTIME_LOOP_RUN_REQUIRED');
  if (message === 'LOOP_RUN_NOT_FOUND') throw createError(404, 'Loop run not found', 'LOOP_RUN_NOT_FOUND');
  throw error;
}

function runtimeReadiness(db: Database, runtimeInput?: unknown) {
  const allowedProduction = new Set(['codex', 'opencode']);
  const requested = typeof runtimeInput === 'string' && runtimeInput.trim()
    ? [runtimeInput.trim().toLowerCase()]
    : ['codex', 'opencode'];
  const contracts = new LoopService(db).getRuntimeContracts().runtimes;
  const runtimes = requested.map((runtime) => {
    const contract = contracts[runtime] || { runtime, available: false, command: null, status: 'unavailable', evidence: [], reason: 'unsupported runtime' };
    const blocked: string[] = [];
    if (!allowedProduction.has(runtime)) blocked.push('non_mock_supported_runtime_required');
    if (!contract.available) blocked.push('runtime_unavailable');
    if (contract.status !== 'ok') blocked.push(`runtime_contract_${contract.status || 'unknown'}`);
    if (contract.reason) blocked.push(String(contract.reason));
    return { runtime, production_runtime: allowedProduction.has(runtime), ready: blocked.length === 0, start_allowed: blocked.length === 0, command: contract.command || null, status: contract.status || 'unavailable', available: Boolean(contract.available), version: contract.version || null, evidence: Array.isArray(contract.evidence) ? contract.evidence : [], blocked_reasons: [...new Set(blocked)], contract };
  });
  return { runtimes, ready: runtimes.some((r) => r.ready), next_safe_action: runtimes.some((r) => r.ready) ? 'Run opt-in real runtime certification' : 'Install or repair codex/opencode runtime before production certification', starts_workers: false };
}

export function createKnowledgeRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const knowledgeRuntime = new KnowledgeRuntimeService(db);

  router.get('/knowledge/runtime', requirePermission('read:evidence'), (_req, res, next) => {
    try { res.json(knowledgeRuntime.health()); } catch (error) { try { mapKnowledgeRuntimeError(error); } catch (mapped) { next(mapped); } }
  });

  router.post('/knowledge/sync', requirePermission('write:swarm_action'), (req, res, next) => {
    try { res.json(knowledgeRuntime.syncCapabilities(req.body || {})); } catch (error) { try { mapKnowledgeRuntimeError(error); } catch (mapped) { next(mapped); } }
  });

  router.get('/runtime-readiness', requirePermission('read:evidence'), (req, res) => {
    try { res.json(runtimeReadiness(db, req.query.runtime)); } catch (error) { /* best-effort */ }
  });

  return router;
}
