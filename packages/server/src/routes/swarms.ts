import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Database } from 'better-sqlite3';
import { WebSocketEventType, type WebSocketMessage } from '@djimitflo/shared';
import type { AuthMiddleware } from '../middleware/auth';
import { createError } from '../middleware/error-handler';
import { AgentAssuranceService } from '../services/agent-assurance-service';
import { CsSkillSwarmHarnessService } from '../services/cs-skill-swarm-harness-service';
import { MemoryCandidateService } from '../services/memory-candidate-service';
import { KnowledgeRuntimeService } from '../services/knowledge-runtime-service';
import { ProofRunService, type ProofRunSummary } from '../services/proof-run-service';
import { SpecialistPanelService } from '../services/specialist-panel-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { LoopService } from '../services/loop-service';
import { OpenCodeHealthService } from '../services/opencode-health-service';
import { SwarmStatusService } from '../services/swarm-status-service';
import { ExpertSwarmOrchestrator } from '../services/expert-swarm-orchestrator';
import type { WebSocketService } from '../services/websocket-service';

type RouteHandler = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function route(handler: RouteHandler): RouteHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = handler(req, res, next);
      if (result instanceof Promise) {
        result.catch(next);
      }
    } catch (error) {
      next(error);
    }
  };
}

function emitProofRunUpdated(wsService: WebSocketService | undefined, summary: ProofRunSummary) {
  if (!wsService) return;
  wsService.broadcastToAuthenticated({
    type: WebSocketEventType.PROOF_RUN_UPDATED,
    payload: {
      id: summary.id,
      status: summary.status,
      passed: summary.passed,
      rollback_safe: summary.rollback_safe,
      runtime: summary.runtime,
    },
    timestamp: new Date().toISOString(),
  } as WebSocketMessage);
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

function mapSpecialistPanelError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'SPECIALIST_PANEL_NOT_FOUND') throw createError(404, 'Specialist panel not found', 'SPECIALIST_PANEL_NOT_FOUND');
  if (message === 'SPECIALIST_PANEL_TOPIC_REQUIRED') throw createError(400, 'topic is required', 'SPECIALIST_PANEL_TOPIC_REQUIRED');
  if (message === 'SPECIALIST_PANEL_QUESTION_REQUIRED') throw createError(400, 'question is required', 'SPECIALIST_PANEL_QUESTION_REQUIRED');
  if (message === 'SPECIALIST_PANEL_RISK_INVALID') throw createError(400, 'risk_class is invalid', 'SPECIALIST_PANEL_RISK_INVALID');
  if (message === 'SPECIALIST_PROFILE_UNKNOWN') throw createError(400, 'specialist profile is unknown', 'SPECIALIST_PROFILE_UNKNOWN');
  if (message === 'SPECIALIST_PANEL_TOO_SMALL') throw createError(400, 'panel requires at least two specialists', 'SPECIALIST_PANEL_TOO_SMALL');
  if (message === 'SPECIALIST_PANEL_SECURITY_REVIEWER_REQUIRED') throw createError(400, 'high-risk panels require security_reviewer', 'SPECIALIST_PANEL_SECURITY_REVIEWER_REQUIRED');
  if (message === 'SPECIALIST_PANEL_CLOSED') throw createError(409, 'specialist panel is closed', 'SPECIALIST_PANEL_CLOSED');
  if (message === 'SPECIALIST_REVIEW_SPECIALIST_REQUIRED') throw createError(400, 'specialist_id is required', 'SPECIALIST_REVIEW_SPECIALIST_REQUIRED');
  if (message === 'SPECIALIST_REVIEW_STANCE_INVALID') throw createError(400, 'stance is invalid', 'SPECIALIST_REVIEW_STANCE_INVALID');
  if (message === 'SPECIALIST_REVIEW_CONFIDENCE_INVALID') throw createError(400, 'confidence is invalid', 'SPECIALIST_REVIEW_CONFIDENCE_INVALID');
  if (message === 'SPECIALIST_REVIEWER_NOT_IN_PANEL') throw createError(400, 'reviewer is not in panel', 'SPECIALIST_REVIEWER_NOT_IN_PANEL');
  if (message === 'SPECIALIST_PANEL_CONSENSUS_REQUIRED') throw createError(409, 'panel consensus is required before backlog projection', 'SPECIALIST_PANEL_CONSENSUS_REQUIRED');
  if (message === 'SPECIALIST_PANEL_BLOCKED') throw createError(409, 'blocked panel cannot be projected to backlog', 'SPECIALIST_PANEL_BLOCKED');
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
  if (message === 'ASSURANCE_LOOP_RUN_NOT_FOUND') throw createError(404, 'loop run not found', 'ASSURANCE_LOOP_RUN_NOT_FOUND');
  if (message === 'ASSURANCE_CHECKPOINT_NOT_FOUND') throw createError(404, 'checkpoint not found', 'ASSURANCE_CHECKPOINT_NOT_FOUND');
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

function mapWorkerPoolError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'WORKER_LEASE_NOT_FOUND') throw createError(404, 'Worker lease not found', 'WORKER_LEASE_NOT_FOUND');
  if (message === 'WORKER_LEASE_NOT_STOPPABLE') throw createError(409, 'Worker lease is not stoppable', 'WORKER_LEASE_NOT_STOPPABLE');
  throw error;
}

function mapKnowledgeRuntimeError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'KNOWLEDGE_RUNTIME_OKF_BASE_MISSING') throw createError(404, 'Canonical OKF base is missing', 'KNOWLEDGE_RUNTIME_OKF_BASE_MISSING');
  if (message === 'KNOWLEDGE_RUNTIME_PACKAGES_KNOWLEDGE_NOT_CANONICAL') throw createError(409, 'packages/knowledge is not the canonical runtime OKF base', 'KNOWLEDGE_RUNTIME_PACKAGES_KNOWLEDGE_NOT_CANONICAL');
  if (message === 'KNOWLEDGE_RUNTIME_OKF_VALIDATION_FAILED') throw createError(422, 'OKF validation failed', 'KNOWLEDGE_RUNTIME_OKF_VALIDATION_FAILED');
  if (message === 'KNOWLEDGE_RUNTIME_LOOP_RUN_REQUIRED') throw createError(400, 'loop_run_id is required', 'KNOWLEDGE_RUNTIME_LOOP_RUN_REQUIRED');
  if (message === 'LOOP_RUN_NOT_FOUND') throw createError(404, 'Loop run not found', 'LOOP_RUN_NOT_FOUND');
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

function mapProofRunError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'PROOF_RUN_NOT_FOUND') throw createError(404, 'Proof run not found', 'PROOF_RUN_NOT_FOUND');
  if (message === 'PROOF_RUN_RUNTIME_UNSUPPORTED') throw createError(400, 'Unsupported proof runtime', 'PROOF_RUN_RUNTIME_UNSUPPORTED');
  // A real runtime/worktree failure (e.g. git worktree lock contention under
  // concurrent fleet operation) — transient infrastructure, not a client error.
  // Map to a stable 503 so it is observable and distinguishable from a bare 500
  // INTERNAL_ERROR fall-through.
  if (message.startsWith('PROOF_RUN_RUNTIME_FAILED')) throw createError(503, message, 'PROOF_RUN_RUNTIME_FAILED');
  if (message === 'PROOF_RUN_VERIFICATION_BLOCKED') throw createError(422, 'Proof run verification blocked', 'PROOF_RUN_VERIFICATION_BLOCKED');
  if (message === 'PROOF_RUN_COMPLETE_FAILED') throw createError(500, 'Proof run completion failed', 'PROOF_RUN_COMPLETE_FAILED');
  throw error;
}

function runtimeReadiness(db: Database, runtimeInput?: unknown) {
  const allowedProduction = new Set(['codex', 'opencode']);
  const requested = typeof runtimeInput === 'string' && runtimeInput.trim()
    ? [runtimeInput.trim().toLowerCase()]
    : ['codex', 'opencode'];
  const contracts = new LoopService(db).getRuntimeContracts().runtimes;
  const runtimes = requested.map((runtime) => {
    const contract = contracts[runtime] || {
      runtime,
      available: false,
      command: null,
      status: 'unavailable',
      evidence: [],
      reason: 'unsupported runtime',
    };
    const blocked = [];
    if (!allowedProduction.has(runtime)) blocked.push('non_mock_supported_runtime_required');
    if (!contract.available) blocked.push('runtime_unavailable');
    if (contract.status !== 'ok') blocked.push(`runtime_contract_${contract.status || 'unknown'}`);
    if (contract.reason) blocked.push(String(contract.reason));
    return {
      runtime,
      production_runtime: allowedProduction.has(runtime),
      ready: blocked.length === 0,
      start_allowed: blocked.length === 0,
      command: contract.command || null,
      status: contract.status || 'unavailable',
      available: Boolean(contract.available),
      version: contract.version || null,
      evidence: Array.isArray(contract.evidence) ? contract.evidence : [],
      blocked_reasons: [...new Set(blocked)],
      contract,
    };
  });
  return {
    runtimes,
    ready: runtimes.some((runtime) => runtime.ready),
    next_safe_action: runtimes.some((runtime) => runtime.ready)
      ? 'Run opt-in real runtime certification'
      : 'Install or repair codex/opencode runtime before production certification',
    starts_workers: false,
  };
}

function productionCertification(latest: ProofRunSummary | null) {
  if (!latest) {
    return {
      status: 'missing',
      proof_run_id: null,
      runtime: null,
      proof_class: null,
      production_passed: false,
      production_missing: ['no_proof_run'],
      next_safe_action: 'Run real runtime proof certification',
    };
  }
  const production = latest.proof_class === 'production' && latest.production_passed;
  return {
    status: production ? 'certified' : latest.proof_class === 'production' ? 'incomplete' : 'demo',
    proof_run_id: latest.id,
    runtime: latest.runtime,
    proof_class: latest.proof_class,
    production_passed: latest.production_passed,
    production_missing: latest.production_missing,
    next_safe_action: production
      ? 'Review production evidence and candidates'
      : latest.proof_class === 'demo'
        ? 'Run proof with codex or opencode'
        : 'Resolve production_missing reasons',
  };
}

function mapCsSkillSwarmHarnessError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'CS_SKILL_SWARM_RUNTIME_INVALID') throw createError(400, 'Unsupported CS skill swarm runtime', 'CS_SKILL_SWARM_RUNTIME_INVALID');
  throw error;
}

  function mapSwarmIntelligenceError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'SWARM_INTELLIGENCE_SECRET_DETECTED') throw createError(400, 'swarm intelligence payload appears to contain a secret', 'SWARM_INTELLIGENCE_SECRET_DETECTED');
  if (message === 'KNOWLEDGE_RUNTIME_OKF_PATH_ESCAPE') throw createError(403, 'OKF path is outside allowed roots', 'KNOWLEDGE_RUNTIME_OKF_PATH_ESCAPE');
  if (message?.startsWith('CAPABILITY_PROMOTION_EVIDENCE_REQUIRED')) throw createError(409, 'capability promotion requires evidence refs', 'CAPABILITY_PROMOTION_EVIDENCE_REQUIRED');
  if (message?.startsWith('CAPABILITY_PROMOTION_SECURITY_CHECKER_REQUIRED')) throw createError(409, 'high/critical capability promotion requires security checker ref', 'CAPABILITY_PROMOTION_SECURITY_CHECKER_REQUIRED');
  if (message?.startsWith('CAPABILITY_PROMOTION_HUMAN_APPROVAL_REQUIRED')) throw createError(409, 'high/critical capability promotion requires human approval ref', 'CAPABILITY_PROMOTION_HUMAN_APPROVAL_REQUIRED');
  if (message?.startsWith('SWARM_INVALID_TRANSITION:')) { const [, from, to] = message.split(':'); throw createError(400, `invalid state transition: ${from} -> ${to}`, 'SWARM_INVALID_TRANSITION'); }
  if (message === 'SWARM_MISSION_NOT_FOUND') throw createError(404, 'swarm mission not found', 'SWARM_MISSION_NOT_FOUND');
  if (message === 'SWARM_MISSION_TITLE_REQUIRED') throw createError(400, 'mission title is required', 'SWARM_MISSION_TITLE_REQUIRED');
  if (message === 'SWARM_MISSION_RISK_INVALID') throw createError(400, 'mission risk class is invalid', 'SWARM_MISSION_RISK_INVALID');
  if (message === 'SWARM_TASK_NOT_FOUND') throw createError(404, 'swarm task not found', 'SWARM_TASK_NOT_FOUND');
  if (message === 'SWARM_TASK_TITLE_REQUIRED') throw createError(400, 'task title is required', 'SWARM_TASK_TITLE_REQUIRED');
  if (message === 'SWARM_TASK_MISSION_REQUIRED') throw createError(400, 'task mission_id is required', 'SWARM_TASK_MISSION_REQUIRED');
  if (message === 'SWARM_DECISION_TYPE_INVALID') throw createError(400, 'decision type is invalid', 'SWARM_DECISION_TYPE_INVALID');
  if (message === 'SWARM_DECISION_REQUIRED') throw createError(400, 'decision is required', 'SWARM_DECISION_REQUIRED');
  if (message === 'SWARM_CAPABILITY_NOT_FOUND') throw createError(404, 'Capability not found', 'SWARM_CAPABILITY_NOT_FOUND');
  if (message === 'SWARM_CAPABILITY_ID_REQUIRED') throw createError(400, 'capability id is required', 'SWARM_CAPABILITY_ID_REQUIRED');
  if (message === 'SWARM_CAPABILITY_KIND_INVALID') throw createError(400, 'capability kind is invalid', 'SWARM_CAPABILITY_KIND_INVALID');
  if (message === 'SWARM_CAPABILITY_OWNER_REQUIRED') throw createError(400, 'capability owner is required', 'SWARM_CAPABILITY_OWNER_REQUIRED');
  if (message === 'SWARM_CAPABILITY_VERSION_REQUIRED') throw createError(400, 'capability version is required', 'SWARM_CAPABILITY_VERSION_REQUIRED');
  if (message === 'SWARM_CAPABILITY_STATUS_INVALID') throw createError(400, 'capability status is invalid', 'SWARM_CAPABILITY_STATUS_INVALID');
  if (message === 'SWARM_CAPABILITY_RISK_INVALID') throw createError(400, 'capability risk ceiling is invalid', 'SWARM_CAPABILITY_RISK_INVALID');
  if (message === 'SWARM_CAPABILITY_INPUT_SCHEMA_REQUIRED') throw createError(400, 'capability input schema is required', 'SWARM_CAPABILITY_INPUT_SCHEMA_REQUIRED');
  if (message === 'SWARM_CAPABILITY_OUTPUT_SCHEMA_REQUIRED') throw createError(400, 'capability output schema is required', 'SWARM_CAPABILITY_OUTPUT_SCHEMA_REQUIRED');
  if (message === 'SWARM_CAPABILITY_ALLOWED_ACTIONS_REQUIRED') throw createError(400, 'capability allowed actions are required', 'SWARM_CAPABILITY_ALLOWED_ACTIONS_REQUIRED');
  if (message === 'SWARM_CAPABILITY_FORBIDDEN_ACTIONS_REQUIRED') throw createError(400, 'capability forbidden actions are required', 'SWARM_CAPABILITY_FORBIDDEN_ACTIONS_REQUIRED');
  if (message === 'SWARM_CAPABILITY_REQUIRED_EVIDENCE_REQUIRED') throw createError(400, 'capability required evidence is required', 'SWARM_CAPABILITY_REQUIRED_EVIDENCE_REQUIRED');
    if (message === 'SWARM_CAPABILITY_REMOVAL_STRATEGY_REQUIRED') throw createError(400, 'capability removal strategy is required', 'SWARM_CAPABILITY_REMOVAL_STRATEGY_REQUIRED');
    if (message === 'SWARM_OKF_BASE_FORBIDDEN') throw createError(403, 'OKF base path is not permitted', 'SWARM_OKF_BASE_FORBIDDEN');
    if (message === 'SWARM_CLAIM_NOT_FOUND') throw createError(404, 'Claim not found', 'SWARM_CLAIM_NOT_FOUND');
    if (message === 'SWARM_CLAIM_TEXT_REQUIRED') throw createError(400, 'claim text is required', 'SWARM_CLAIM_TEXT_REQUIRED');
    if (message === 'SWARM_CLAIM_TYPE_INVALID') throw createError(400, 'claim type is invalid', 'SWARM_CLAIM_TYPE_INVALID');
    if (message === 'SWARM_CLAIM_REF_NOT_FOUND') throw createError(400, 'claim reference not found', 'SWARM_CLAIM_REF_NOT_FOUND');
    if (message === 'SWARM_CLAIM_SUBJECT_REQUIRED') throw createError(400, 'claim subject_ref is required', 'SWARM_CLAIM_SUBJECT_REQUIRED');
    if (message === 'SWARM_CLAIM_CREATED_FROM_REQUIRED') throw createError(400, 'claim created_from is required', 'SWARM_CLAIM_CREATED_FROM_REQUIRED');
    if (message === 'SWARM_CLAIM_VALID_UNTIL_INVALID') throw createError(400, 'claim valid_until timestamp is invalid', 'SWARM_CLAIM_VALID_UNTIL_INVALID');
    if (message === 'SWARM_EVIDENCE_EDGE_INVALID') throw createError(400, 'evidence edge is invalid', 'SWARM_EVIDENCE_EDGE_INVALID');
  if (message === 'SWARM_RUNNER_DECISION_ID_REQUIRED') throw createError(400, 'runner decision_id is required', 'SWARM_RUNNER_DECISION_ID_REQUIRED');
  if (message === 'SWARM_RUNNER_ACTION_INVALID') throw createError(400, 'runner manifest action is invalid', 'SWARM_RUNNER_ACTION_INVALID');
  if (message === 'SWARM_RUNNER_POLICY_VERSION_REQUIRED') throw createError(400, 'runner policy_version is required', 'SWARM_RUNNER_POLICY_VERSION_REQUIRED');
  if (message === 'SWARM_GOVERNANCE_RISK_INVALID') throw createError(400, 'governance risk_class is invalid', 'SWARM_GOVERNANCE_RISK_INVALID');
  throw error;
}

export function createSwarmRoutes(db: Database, auth?: AuthMiddleware, wsService?: WebSocketService): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const service = new SwarmStatusService(db);
  const assurance = new AgentAssuranceService(db);
  const knowledgeRuntime = new KnowledgeRuntimeService(db);
  const memoryCandidates = new MemoryCandidateService(db);
  const specialistPanels = new SpecialistPanelService(db);
  const intelligence = new SwarmIntelligenceService(db);
  const proofRuns = new ProofRunService(db);
  const csSkillSwarmHarness = new CsSkillSwarmHarnessService(db);

  router.get('/status', requirePermission('read:evidence'), route((_req, res) => {
    res.json(service.getStatus());
  }));

  router.post('/scheduler/tick', requirePermission('write:swarm_action'), route((req, res) => {
    res.json(service.tickScheduler(req.body || {}));
  }));

  router.post('/backlog/sync', requirePermission('write:swarm_action'), route((req, res, next) => {
    try {
      res.json(service.syncBacklogFromFleet(req.body || {}));
    } catch (error) {
      try {
        mapKnowledgeRuntimeError(error);
      } catch (mapped) {
        next(mapped);
      }
      next(error);
    }
  }));

  router.get('/knowledge/runtime', requirePermission('read:evidence'), (_req, res, next) => {
    try {
      res.json(knowledgeRuntime.health());
    } catch (error) {
      try {
        mapKnowledgeRuntimeError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.get('/runtime-readiness', requirePermission('read:evidence'), route((req, res) => {
    res.json(runtimeReadiness(db, req.query.runtime));
  }));

  router.post('/knowledge/sync', requirePermission('write:swarm_action'), (req, res, next) => {
    try {
      res.json(knowledgeRuntime.syncCapabilities(req.body || {}));
    } catch (error) {
      try {
        mapKnowledgeRuntimeError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/worker-pool/plan', requirePermission('read:evidence'), (req, res, next) => {
    try {
      res.json(service.planWorkerPool(req.body || {}));
    } catch (error) {
      try {
        mapWorkerPoolError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/worker-pool/start-next', requirePermission('write:swarm_action'), async (req, res, next) => {
    try {
      res.json(await service.startNextWorker(req.body || {}));
    } catch (error) {
      try {
        mapWorkerPoolError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/worker-pool/drain', requirePermission('write:swarm_action'), async (req, res, next) => {
    try {
      res.json(await service.drainWorkerPool(req.body || {}));
    } catch (error) {
      try {
        mapWorkerPoolError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/worker-pool/stop/:leaseId', requirePermission('write:swarm_action'), (req, res, next) => {
    try {
      res.json(service.stopWorkerLease(req.params.leaseId));
    } catch (error) {
      try {
        mapWorkerPoolError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/handoffs', requirePermission('write:swarm_action'), async (req, res, next) => {
    try {
      res.status(201).json(await service.createHandoff(req.body || {}));
    } catch (error) {
      try {
        mapHandoffError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/handoffs/drain', requirePermission('write:swarm_action'), async (req, res, next) => {
    try {
      res.json(await service.drainHandoffs(req.body || {}));
    } catch (error) {
      try {
        mapHandoffError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/handoffs/:id/accept', requirePermission('write:swarm_action'), (req, res, next) => {
    try {
      res.json(service.acceptHandoff(req.params.id));
    } catch (error) {
      try {
        mapHandoffError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/evolution/run', requirePermission('write:governance'), (req, res, next) => {
    try {
      res.status(201).json(service.runEvolutionCycle(req.body || {}));
    } catch (error) {
      try {
        mapAssuranceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/evolution/close-loop', requirePermission('write:governance'), (req, res, next) => {
    try {
      res.status(201).json(knowledgeRuntime.closeLoop(req.body || {}));
    } catch (error) {
      try {
        mapKnowledgeRuntimeError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/cs-skill-intelligence/run', requirePermission('write:swarm_action'), async (req, res, next) => {
    try {
      res.status(201).json(await csSkillSwarmHarness.run(req.body || {}));
    } catch (error) {
      try {
        mapCsSkillSwarmHarnessError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.get('/intelligence/mission-control', requirePermission('read:evidence'), (req, res, next) => {
    // G14: when ?live=true, switch to SSE streaming for real-time observability.
    if (req.query.live === 'true') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      // Send initial snapshot.
      try {
        const latest = proofRuns.latest();
        const snapshot = {
          ...intelligence.missionControl(),
          latest_proof_run: latest,
          production_certification: productionCertification(latest),
          runtime_readiness: runtimeReadiness(db),
        };
        res.write(`data: ${JSON.stringify({ type: 'snapshot', data: snapshot })}\n\n`);
      } catch { /* best-effort */ }
      // Subscribe to live events.
      const { swarmEventBus } = require('../services/swarm-event-bus');
      const unsub = swarmEventBus.subscribe((event: any) => {
        try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* disconnected */ }
      });
      const ka = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { clearInterval(ka); } }, 15_000);
      req.on('close', () => { unsub(); clearInterval(ka); });
      return;
    }
    try {
      const latest = proofRuns.latest();
      res.json({
        ...intelligence.missionControl(),
        latest_proof_run: latest,
        production_certification: productionCertification(latest),
        runtime_readiness: runtimeReadiness(db),
      });
    } catch (error) {
      try {
        mapSwarmIntelligenceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  // G18: GET /api/swarms/economy — reports verified_artifacts / dollar per capability.
  // This is the ship-gate goal: a real production endpoint that uses G13 (dollar economy).
  router.get('/economy', requirePermission('read:evidence'), (_req, res, next) => {
    try {
      const loops = new LoopService(db);
      const caps = intelligence.listCapabilities().filter(c => c.status === 'validated' || c.status === 'candidate');
      const economies = caps.map(cap => {
        const competence = intelligence.measureCompetence(cap.id);
        const costModel = cap.cost_model as Record<string, unknown>;
        const p50Dollars = typeof costModel.p50_dollars === 'number' ? costModel.p50_dollars : 0;
        const efficiency = competence.n_completed > 0 && p50Dollars > 0
          ? competence.n_completed / p50Dollars
          : null;
        return {
          capability_id: cap.id,
          capability_kind: cap.kind,
          status: cap.status,
          n_runs: competence.n_runs,
          n_completed: competence.n_completed,
          success_rate: competence.success_rate,
          p50_tokens: competence.p50_cost,
          p95_tokens: competence.p95_cost,
          p50_dollars: p50Dollars,
          p95_dollars: typeof costModel.p95_dollars === 'number' ? costModel.p95_dollars : 0,
          verified_artifacts_per_dollar: efficiency,
        };
      });
      // Also report per-run efficiency for recent runs.
      const recentRuns = loops.listLoopRuns().slice(0, 10);
      const runEconomies = recentRuns.map(run => {
        const metric = loops.computeEfficiencyMetric(run.id);
        return {
          run_id: run.id,
          loop_name: run.loop_name,
          status: run.status,
          verified_artifacts: metric.verifiedArtifacts,
          dollars_spent: metric.dollarsSpent,
          efficiency: metric.efficiency,
        };
      });
      res.json({
        capabilities: economies,
        recent_runs: runEconomies,
        summary: {
          total_capabilities: economies.length,
          total_verified_artifacts: runEconomies.reduce((s, r) => s + r.verified_artifacts, 0),
          total_dollars_spent: runEconomies.reduce((s, r) => s + r.dollars_spent, 0),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  // D11: GET /api/swarms/learning-curve — inter-run learning verification
  router.get('/learning-curve', requirePermission('read:evidence'), (_req, res, next) => {
    try {
      const loopSvc = new LoopService(db); const curve = loopSvc.computeLearningCurve(20);
      res.json(curve);
    } catch (error) {
      next(error);
    }
  });

  router.post('/proof-runs', requirePermission('write:governance'), async (req, res, next) => {
    try {
      const summary = await proofRuns.create(req.body || {});
      emitProofRunUpdated(wsService, summary);
      res.status(201).json(summary);
    } catch (error) {
      try {
        mapProofRunError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.get('/proof-runs/latest', requirePermission('read:evidence'), (_req, res, next) => {
    try {
      const latest = proofRuns.latest();
      if (!latest) {
        throw new Error('PROOF_RUN_NOT_FOUND');
      }
      res.json(latest);
    } catch (error) {
      try {
        mapProofRunError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.get('/proof-runs/:id', requirePermission('read:evidence'), (req, res, next) => {
    try {
      res.json(proofRuns.get(req.params.id));
    } catch (error) {
      try {
        mapProofRunError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/proof-runs/:id/rollback', requirePermission('write:governance'), (req, res, next) => {
    try {
      const summary = proofRuns.rollback(req.params.id);
      emitProofRunUpdated(wsService, summary);
      res.json(summary);
    } catch (error) {
      try {
        mapProofRunError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.get('/intelligence/capabilities', requirePermission('read:evidence'), (req, res, next) => {
    try {
      res.json({ capabilities: intelligence.listCapabilities(req.query.limit ? Number(req.query.limit) : undefined) });
    } catch (error) {
      try {
        mapSwarmIntelligenceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/intelligence/capabilities', requirePermission('write:capability'), (req, res, next) => {
    try {
      res.status(201).json(intelligence.registerCapability(req.body || {}));
    } catch (error) {
      try {
        mapSwarmIntelligenceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/intelligence/capabilities/candidate', requirePermission('write:capability'), (req, res, next) => {
    try {
      res.status(201).json(intelligence.createCandidate(req.body || {}));
    } catch (error) {
      try { mapSwarmIntelligenceError(error); } catch (mapped) { next(mapped); }
    }
  });

  router.post('/intelligence/capabilities/:id/promote', requirePermission('write:capability'), (req, res, next) => {
    try {
      res.json(intelligence.promoteCapability(req.params.id, req.body || {}));
    } catch (error) {
      try { mapSwarmIntelligenceError(error); } catch (mapped) { next(mapped); }
    }
  });

  router.post('/intelligence/capabilities/:id/evaluate', requirePermission('write:capability'), (req, res, next) => {
    try {
      res.json(intelligence.evaluateCapability(req.params.id));
    } catch (error) {
      try {
        mapSwarmIntelligenceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.get('/intelligence/specialists', requirePermission('read:evidence'), (_req, res, next) => {
    try {
      res.json({ specialists: intelligence.listSpecialistProfiles() });
    } catch (error) {
      next(error);
    }
  });

  router.get('/intelligence/claims', requirePermission('read:evidence'), (req, res, next) => {
    try {
      res.json({ claims: intelligence.listClaims(req.query.limit ? Number(req.query.limit) : undefined) });
    } catch (error) {
      try {
        mapSwarmIntelligenceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/intelligence/claims', requirePermission('write:claim'), (req, res, next) => {
    try {
      res.status(201).json(intelligence.createClaim(req.body || {}));
    } catch (error) {
      try {
        mapSwarmIntelligenceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/intelligence/capacity/plan', requirePermission('read:evidence'), (req, res, next) => {
    try {
      res.json(intelligence.planCapacityV2(req.body || {}));
    } catch (error) {
      try {
        mapSwarmIntelligenceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.get('/intelligence/runner-manifests', requirePermission('read:evidence'), (req, res, next) => {
    try {
      res.json({ manifests: intelligence.listRunnerManifests(req.query.limit ? Number(req.query.limit) : undefined) });
    } catch (error) {
      try {
        mapSwarmIntelligenceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/intelligence/runner-manifests', requirePermission('write:runner_manifest'), (req, res, next) => {
    try {
      // G16.2: Block direct public assertion of completed runner manifests
      // Only auto-write from loop-service should create 'complete'/'fail'/'kill' manifests
      const blockedActions = ['complete', 'fail', 'kill', 'timeout'];
      const action = req.body?.action;
      if (action && blockedActions.includes(action)) {
        throw createError(403, 'completed runner manifests can only be auto-written by the runner, not asserted via API', 'RUNNER_MANIFEST_DIRECT_ASSERTION_BLOCKED');
      }
      res.status(201).json(intelligence.createRunnerManifest(req.body || {}));
    } catch (error) {
      try {
        mapSwarmIntelligenceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/intelligence/governance/evaluate', requirePermission('write:governance'), (req, res, next) => {
    try {
      res.json(intelligence.evaluateGovernance(req.body || {}));
    } catch (error) {
      try {
        mapSwarmIntelligenceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.get('/intelligence/okf-drift', requirePermission('read:evidence'), (req, res, next) => {
    try {
      res.json(intelligence.okfDriftReport(req.query.okf_base ? String(req.query.okf_base) : undefined));
    } catch (error) {
      try {
        mapSwarmIntelligenceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.get('/assurance/summary', requirePermission('read:evidence'), (_req, res, next) => {
    try {
      res.json(assurance.summary());
    } catch (error) {
      next(error);
    }
  });

  router.post('/assurance/trace-spans', requirePermission('write:swarm_action'), (req, res, next) => {
    try {
      res.status(201).json(assurance.createTraceSpan(req.body || {}));
    } catch (error) {
      try {
        mapAssuranceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.get('/assurance/traces/:traceId', requirePermission('read:evidence'), (req, res, next) => {
    try {
      res.json(assurance.getTrace(req.params.traceId));
    } catch (error) {
      try {
        mapAssuranceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/assurance/checkpoints', requirePermission('write:swarm_action'), (req, res, next) => {
    try {
      res.status(201).json(assurance.createCheckpoint(req.body || {}));
    } catch (error) {
      try {
        mapAssuranceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/assurance/checkpoints/:id/branch', requirePermission('write:swarm_action'), (req, res, next) => {
    try {
      res.status(201).json(assurance.branchCheckpoint(req.params.id, req.body || {}));
    } catch (error) {
      try {
        mapAssuranceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/assurance/evals/run', requirePermission('write:swarm_action'), (req, res, next) => {
    try {
      res.status(201).json(assurance.runEval(req.body || {}));
    } catch (error) {
      try {
        mapAssuranceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.get('/assurance/capability-tokens', requirePermission('read:evidence'), route((req, res) => {
    res.json(assurance.listCapabilityTokens(req.query.limit ? Number(req.query.limit) : undefined));
  }));

  router.post('/assurance/capability-tokens', requirePermission('write:swarm_action'), (req, res, next) => {
    try {
      res.status(201).json(assurance.issueCapabilityToken(req.body || {}));
    } catch (error) {
      try {
        mapAssuranceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.get('/assurance/reflections', requirePermission('read:evidence'), route((req, res) => {
    res.json(assurance.listReflections(req.query.limit ? Number(req.query.limit) : undefined));
  }));

  router.post('/assurance/reflections', requirePermission('write:swarm_action'), (req, res, next) => {
    try {
      res.status(201).json(assurance.createReflection(req.body || {}));
    } catch (error) {
      try {
        mapAssuranceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.get('/memory/candidates', requirePermission('read:evidence'), route((req, res) => {
    res.json(memoryCandidates.list(req.query.limit ? Number(req.query.limit) : undefined));
  }));

  router.post('/memory/candidates', requirePermission('write:claim'), (req, res, next) => {
    try {
      res.status(201).json(memoryCandidates.create(req.body || {}));
    } catch (error) {
      try {
        mapMemoryCandidateError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/memory/candidates/:id/promote', requirePermission('write:claim'), (req, res, next) => {
    try {
      res.json(memoryCandidates.promote(req.params.id, req.body || {}));
    } catch (error) {
      try {
        mapMemoryCandidateError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.get('/specialists/catalog', requirePermission('read:evidence'), (_req, res, next) => {
    try {
      res.json({ specialists: specialistPanels.getCatalog() });
    } catch (error) {
      next(error);
    }
  });

  router.get('/specialist-panels', requirePermission('read:evidence'), route((req, res) => {
    res.json(specialistPanels.listPanels(req.query.limit ? Number(req.query.limit) : undefined));
  }));

  router.post('/specialist-panels', requirePermission('write:swarm_action'), (req, res, next) => {
    try {
      res.status(201).json(specialistPanels.createPanel(req.body || {}));
    } catch (error) {
      try {
        mapSpecialistPanelError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.get('/specialist-panels/:id', requirePermission('read:evidence'), (req, res, next) => {
    try {
      res.json(specialistPanels.getPanel(req.params.id));
    } catch (error) {
      try {
        mapSpecialistPanelError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/specialist-panels/:id/reviews', requirePermission('write:swarm_action'), (req, res, next) => {
    try {
      res.json(specialistPanels.submitReview(req.params.id, req.body || {}));
    } catch (error) {
      try {
        mapSpecialistPanelError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/specialist-panels/:id/backlog', requirePermission('write:swarm_action'), (req, res, next) => {
    try {
      res.status(201).json(specialistPanels.projectPanelToBacklog(req.params.id));
    } catch (error) {
      try {
        mapSpecialistPanelError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  // G16.3: OpenCode health endpoint
  router.get('/opencode/health', requirePermission('read:evidence'), (_req, res, next) => {
    try {
      const health = new OpenCodeHealthService();
      res.json(health.inspectConfig());
    } catch (error) {
      next(error);
    }
  });

  // G15.8: Hypothesis workbench endpoints
  router.get('/intelligence/hypotheses', requirePermission('read:evidence'), route((req, res) => {
    res.json(intelligence.listHypotheses(Number(req.query.limit) || 100));
  }));

  router.post('/intelligence/hypotheses', requirePermission('write:swarm_action'), (req, res, next) => {
    try { res.status(201).json(intelligence.createHypothesis(req.body || {})); }
    catch (error) { try { mapSwarmIntelligenceError(error); } catch (mapped) { next(mapped); } }
  });

  router.post('/intelligence/hypotheses/:id/transition', requirePermission('write:swarm_action'), (req, res, next) => {
    try { res.json(intelligence.transitionHypothesis(req.params.id, req.body.state, req.body.evidence_refs)); }
    catch (error) { try { mapSwarmIntelligenceError(error); } catch (mapped) { next(mapped); } }
  });

  // G14.1: Swarm Intelligence Kernel — mission/task/decision endpoints
  router.get('/intelligence/missions', (req, res) => {
    const svc = new SwarmIntelligenceService(db);
    res.json({ missions: svc.listMissions(Number(req.query.limit) || 100) });
  });

  router.post('/intelligence/missions', (req, res) => {
    const svc = new SwarmIntelligenceService(db);
    res.status(201).json(svc.createMission(req.body));
  });

  router.get('/intelligence/missions/:id', (req, res) => {
    const svc = new SwarmIntelligenceService(db);
    res.json(svc.getMission(req.params.id));
  });

  router.post('/intelligence/missions/:id/transition', (req, res) => {
    const svc = new SwarmIntelligenceService(db);
    res.json(svc.transitionMission(req.params.id, req.body.status, req.body));
  });

  router.get('/intelligence/missions/:id/tasks', (req, res) => {
    const svc = new SwarmIntelligenceService(db);
    res.json({ tasks: svc.listTasks(req.params.id) });
  });

  router.post('/intelligence/missions/:id/tasks', (req, res) => {
    const svc = new SwarmIntelligenceService(db);
    res.status(201).json(svc.createTask({ ...req.body, mission_id: req.params.id }));
  });

  router.post('/intelligence/tasks/:id/transition', (req, res) => {
    const svc = new SwarmIntelligenceService(db);
    res.json(svc.transitionTask(req.params.id, req.body.status, req.body));
  });

  router.get('/intelligence/missions/:id/decisions', (req, res) => {
    const svc = new SwarmIntelligenceService(db);
    res.json({ decisions: svc.listDecisions(req.params.id) });
  });

  router.post('/intelligence/decisions', (req, res) => {
    const svc = new SwarmIntelligenceService(db);
    res.status(201).json(svc.recordDecision(req.body));
  });

  // G14.8: Circuit breaker endpoints
  router.get('/intelligence/circuit-breaker/:scope', (req, res) => {
    const svc = new SwarmIntelligenceService(db);
    res.json(svc.checkCircuitBreaker(req.params.scope));
  });

  router.post('/intelligence/circuit-breaker/:scope/failure', (req, res) => {
    const svc = new SwarmIntelligenceService(db);
    res.json(svc.recordCircuitBreakerFailure(req.params.scope));
  });
  router.post('/intelligence/circuit-breaker/:scope/reset', (req, res) => {
    const svc = new SwarmIntelligenceService(db);
    svc.resetCircuitBreaker(req.params.scope);
    res.json({ reset: true });
  });

  // G93: Expert Swarm endpoints
  router.post('/expert/dispatch', requirePermission('write:swarm_action'), route(async (req, res) => {
    const orchestrator = new ExpertSwarmOrchestrator(db);
    const result = await orchestrator.dispatch({
      topic: req.body.topic || '',
      domains: req.body.domains || [],
      maxParallel: req.body.max_parallel,
      sources: req.body.sources,
    });
    res.json(result);
  }));

  router.get('/expert/history', requirePermission('read:evidence'), route((_req, res) => {
    const orchestrator = new ExpertSwarmOrchestrator(db);
    res.json(orchestrator.getHistory(20));
  }));

  router.get('/expert/sources', requirePermission('read:evidence'), route((_req, res) => {
    const orchestrator = new ExpertSwarmOrchestrator(db);
    res.json({ sources: orchestrator.getAvailableSources() });
  }));

  return router;
}
