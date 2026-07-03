/**
 * Governance routes — proof runs, evolution, assurance, memory candidates.
 *
 * Extracted from swarms.ts (Phase B3 decomposition).
 * Handles: proof run lifecycle, evolution cycles, agent assurance (traces,
 * checkpoints, evals, reflections), memory candidate management.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { createError } from '../middleware/error-handler';
import type { AuthMiddleware } from '../middleware/auth';
import { AgentAssuranceService } from '../services/agent-assurance-service';
import { MemoryCandidateService } from '../services/memory-candidate-service';
import { ProofRunService, type ProofRunSummary } from '../services/proof-run-service';
import { SwarmStatusService } from '../services/swarm-status-service';
import { KnowledgeRuntimeService } from '../services/knowledge-runtime-service';
import { CsSkillSwarmHarnessService } from '../services/cs-skill-swarm-harness-service';
import type { WebSocketService } from '../services/websocket-service';

function mapProofRunError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'PROOF_RUN_NOT_FOUND') throw createError(404, 'Proof run not found', 'PROOF_RUN_NOT_FOUND');
  if (message === 'PROOF_RUN_RUNTIME_UNSUPPORTED') throw createError(400, 'Unsupported proof runtime', 'PROOF_RUN_RUNTIME_UNSUPPORTED');
  if (message.startsWith('PROOF_RUN_RUNTIME_FAILED')) throw createError(503, message, 'PROOF_RUN_RUNTIME_FAILED');
  if (message === 'PROOF_RUN_VERIFICATION_BLOCKED') throw createError(422, 'Proof run verification blocked', 'PROOF_RUN_VERIFICATION_BLOCKED');
  if (message === 'PROOF_RUN_COMPLETE_FAILED') throw createError(500, 'Proof run completion failed', 'PROOF_RUN_COMPLETE_FAILED');
  throw error;
}

function mapAssuranceError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'ASSURANCE_SECRET_DETECTED') throw createError(400, 'assurance input appears to contain a secret', 'ASSURANCE_SECRET_DETECTED');
  if (message === 'ASSURANCE_TRACE_REQUIRED') throw createError(400, 'trace_id is required', 'ASSURANCE_TRACE_REQUIRED');
  if (message === 'ASSURANCE_SPAN_NAME_REQUIRED') throw createError(400, 'span name is required', 'ASSURANCE_SPAN_NAME_REQUIRED');
  if (message === 'ASSURANCE_SPAN_TYPE_INVALID') throw createError(400, 'span_type is invalid', 'ASSURANCE_SPAN_TYPE_INVALID');
  if (message === 'ASSURANCE_SPAN_STATUS_INVALID') throw createError(400, 'span status is invalid', 'ASSURANCE_SPAN_STATUS_INVALID');
  if (message === 'ASSURANCE_LOOP_RUN_REQUIRED') throw createError(400, 'loop_run_id is required', 'ASSURANCE_LOOP_RUN_REQUIRED');
  if (message === 'ASSURANCE_CHECKPOINT_LABEL_REQUIRED') throw createError(400, 'checkpoint label is required', 'ASSURANCE_CHECKPOINT_LABEL_REQUIRED');
  if (message === 'ASSURANCE_LOOP_RUN_NOT_FOUND') throw createError(404, 'Loop run not found', 'ASSURANCE_LOOP_RUN_NOT_FOUND');
  if (message === 'ASSURANCE_CHECKPOINT_NOT_FOUND') throw createError(404, 'Checkpoint not found', 'ASSURANCE_CHECKPOINT_NOT_FOUND');
  if (message === 'ASSURANCE_EVAL_SUITE_REQUIRED') throw createError(400, 'suite_name is required', 'ASSURANCE_EVAL_SUITE_REQUIRED');
  if (message === 'ASSURANCE_EVAL_TARGET_INVALID') throw createError(400, 'target_type is invalid', 'ASSURANCE_EVAL_TARGET_INVALID');
  if (message === 'ASSURANCE_SCOPE_INVALID') throw createError(400, 'capability scope is invalid', 'ASSURANCE_SCOPE_INVALID');
  if (message === 'ASSURANCE_RISK_INVALID') throw createError(400, 'risk_class is invalid', 'ASSURANCE_RISK_INVALID');
  if (message === 'ASSURANCE_CAPABILITY_APPROVAL_REQUIRED') throw createError(409, 'high-risk capability tokens require explicit approval', 'ASSURANCE_CAPABILITY_APPROVAL_REQUIRED');
  if (message === 'ASSURANCE_REFLECTION_SOURCE_INVALID') throw createError(400, 'reflection source_type is invalid', 'ASSURANCE_REFLECTION_SOURCE_INVALID');
  if (message === 'ASSURANCE_REFLECTION_SOURCE_REQUIRED') throw createError(400, 'reflection source_ref is required', 'ASSURANCE_REFLECTION_SOURCE_REQUIRED');
  if (message === 'ASSURANCE_REFLECTION_LESSON_REQUIRED') throw createError(400, 'reflection lesson is required', 'ASSURANCE_REFLECTION_LESSON_REQUIRED');
  throw error;
}

function mapMemoryCandidateError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'MEMORY_CANDIDATE_NOT_FOUND') throw createError(404, 'Memory candidate not found', 'MEMORY_CANDIDATE_NOT_FOUND');
  if (message === 'MEMORY_CANDIDATE_TITLE_REQUIRED') throw createError(400, 'title is required', 'MEMORY_CANDIDATE_TITLE_REQUIRED');
  if (message === 'MEMORY_CANDIDATE_CONTENT_REQUIRED') throw createError(400, 'content is required', 'MEMORY_CANDIDATE_CONTENT_REQUIRED');
  if (message === 'MEMORY_CANDIDATE_TYPE_INVALID') throw createError(400, 'memory_type is invalid', 'MEMORY_CANDIDATE_TYPE_INVALID');
  if (message === 'MEMORY_CANDIDATE_SECRET_DETECTED') throw createError(400, 'memory candidate appears to contain a secret', 'MEMORY_CANDIDATE_SECRET_DETECTED');
  if (message === 'MEMORY_PROMOTION_HUMAN_APPROVAL_REQUIRED') throw createError(409, 'human approval is required before memory promotion', 'MEMORY_PROMOTION_HUMAN_APPROVAL_REQUIRED');
  if (message === 'MEMORY_PROMOTION_REVIEW_REQUIRED') throw createError(409, 'review is required before memory promotion', 'MEMORY_PROMOTION_REVIEW_REQUIRED');
  if (message === 'MEMORY_PROMOTION_REJECTED_CANDIDATE') throw createError(409, 'rejected memory candidate cannot be promoted', 'MEMORY_PROMOTION_REJECTED_CANDIDATE');
  if (message === 'MEMORY_PROMOTION_SINK_FAILED') throw createError(502, 'memory promotion sink failed', 'MEMORY_PROMOTION_SINK_FAILED');
  throw error;
}

function mapCsSkillSwarmHarnessError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'CS_SKILL_SWARM_RUNTIME_INVALID') throw createError(400, 'Unsupported CS skill swarm runtime', 'CS_SKILL_SWARM_RUNTIME_INVALID');
  throw error;
}

function emitProofRunUpdated(wsService: WebSocketService | undefined, summary: ProofRunSummary) {
  if (!wsService) return;
  wsService.broadcastToAuthenticated({
    type: 'PROOF_RUN_UPDATED' as any,
    payload: { id: summary.id, status: summary.status, passed: summary.passed, rollback_safe: summary.rollback_safe, runtime: summary.runtime },
    timestamp: new Date().toISOString(),
  } as any);
}

export function createGovernanceRoutes(db: Database, auth?: AuthMiddleware, wsService?: WebSocketService): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const service = new SwarmStatusService(db);
  const assurance = new AgentAssuranceService(db);
  const proofRuns = new ProofRunService(db);
  const memoryCandidates = new MemoryCandidateService(db);
  const knowledgeRuntime = new KnowledgeRuntimeService(db);
  const csSkillSwarmHarness = new CsSkillSwarmHarnessService(db);

  // Proof runs
  router.post('/proof-runs', requirePermission('write:governance'), async (req, res, next) => {
    try { const summary = await proofRuns.create(req.body || {}); emitProofRunUpdated(wsService, summary); res.status(201).json(summary); } catch (error) { try { mapProofRunError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.get('/proof-runs/latest', requirePermission('read:evidence'), (_req, res, next) => {
    try { const latest = proofRuns.latest(); if (!latest) throw new Error('PROOF_RUN_NOT_FOUND'); res.json(latest); } catch (error) { try { mapProofRunError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.get('/proof-runs/:id', requirePermission('read:evidence'), (req, res, next) => {
    try { res.json(proofRuns.get(req.params.id)); } catch (error) { try { mapProofRunError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.post('/proof-runs/:id/rollback', requirePermission('write:governance'), (req, res, next) => {
    try { const summary = proofRuns.rollback(req.params.id); emitProofRunUpdated(wsService, summary); res.json(summary); } catch (error) { try { mapProofRunError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  // Evolution
  router.post('/evolution/run', requirePermission('write:governance'), (req, res, next) => {
    try { res.status(201).json(service.runEvolutionCycle(req.body || {})); } catch (error) { try { mapAssuranceError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.post('/evolution/close-loop', requirePermission('write:governance'), (req, res, next) => {
    try { res.status(201).json(knowledgeRuntime.closeLoop(req.body || {})); } catch (error) { next(error); }
  });

  // CS skill intelligence
  router.post('/cs-skill-intelligence/run', requirePermission('write:swarm_action'), async (req, res, next) => {
    try { res.status(201).json(await csSkillSwarmHarness.run(req.body || {})); } catch (error) { try { mapCsSkillSwarmHarnessError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  // Assurance
  router.get('/assurance/summary', requirePermission('read:evidence'), (_req, res, next) => {
    try { res.json(assurance.summary()); } catch (error) { next(error); }
  });

  router.post('/assurance/trace-spans', requirePermission('write:swarm_action'), (req, res, next) => {
    try { res.status(201).json(assurance.createTraceSpan(req.body || {})); } catch (error) { try { mapAssuranceError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.get('/assurance/traces/:traceId', requirePermission('read:evidence'), (req, res, next) => {
    try { res.json(assurance.getTrace(req.params.traceId)); } catch (error) { try { mapAssuranceError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.post('/assurance/checkpoints', requirePermission('write:swarm_action'), (req, res, next) => {
    try { res.status(201).json(assurance.createCheckpoint(req.body || {})); } catch (error) { try { mapAssuranceError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.post('/assurance/checkpoints/:id/branch', requirePermission('write:swarm_action'), (req, res, next) => {
    try { res.status(201).json(assurance.branchCheckpoint(req.params.id, req.body || {})); } catch (error) { try { mapAssuranceError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.post('/assurance/evals/run', requirePermission('write:swarm_action'), (req, res, next) => {
    try { res.status(201).json(assurance.runEval(req.body || {})); } catch (error) { try { mapAssuranceError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.get('/assurance/capability-tokens', requirePermission('read:evidence'), (req, res, next) => {
    try { res.json(assurance.listCapabilityTokens(req.query.limit ? Number(req.query.limit) : undefined)); } catch (error) { try { mapAssuranceError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.post('/assurance/capability-tokens', requirePermission('write:swarm_action'), (req, res, next) => {
    try { res.status(201).json(assurance.issueCapabilityToken(req.body || {})); } catch (error) { try { mapAssuranceError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.get('/assurance/reflections', requirePermission('read:evidence'), (req, res, next) => {
    try { res.json(assurance.listReflections(req.query.limit ? Number(req.query.limit) : undefined)); } catch (error) { try { mapAssuranceError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.post('/assurance/reflections', requirePermission('write:swarm_action'), (req, res, next) => {
    try { res.status(201).json(assurance.createReflection(req.body || {})); } catch (error) { try { mapAssuranceError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  // Memory candidates
  router.get('/memory/candidates', requirePermission('read:evidence'), (req, res, next) => {
    try { res.json(memoryCandidates.list(req.query.limit ? Number(req.query.limit) : undefined)); } catch (error) { next(error); }
  });

  router.post('/memory/candidates', requirePermission('write:claim'), (req, res, next) => {
    try { res.status(201).json(memoryCandidates.create(req.body || {})); } catch (error) { try { mapMemoryCandidateError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.post('/memory/candidates/:id/promote', requirePermission('write:claim'), (req, res, next) => {
    try { res.json(memoryCandidates.promote(req.params.id, req.body || {})); } catch (error) { try { mapMemoryCandidateError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  return router;
}
