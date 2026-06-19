import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { WebSocketEventType, type WebSocketMessage } from '@djimitflo/shared';
import type { AuthMiddleware } from '../middleware/auth';
import { createError } from '../middleware/error-handler';
import { AgentAssuranceService } from '../services/agent-assurance-service';
import { CsSkillSwarmHarnessService } from '../services/cs-skill-swarm-harness-service';
import { MemoryCandidateService } from '../services/memory-candidate-service';
import { ProofRunService, type ProofRunSummary } from '../services/proof-run-service';
import { SpecialistPanelService } from '../services/specialist-panel-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { SwarmStatusService } from '../services/swarm-status-service';
import type { WebSocketService } from '../services/websocket-service';
import { createSpawnRoutes } from './spawns';

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

function mapProofRunError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'PROOF_RUN_NOT_FOUND') throw createError(404, 'Proof run not found', 'PROOF_RUN_NOT_FOUND');
  if (message === 'PROOF_RUN_RUNTIME_UNSUPPORTED') throw createError(400, 'Unsupported proof runtime', 'PROOF_RUN_RUNTIME_UNSUPPORTED');
  throw error;
}

function mapCsSkillSwarmHarnessError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'CS_SKILL_SWARM_RUNTIME_INVALID') throw createError(400, 'Unsupported CS skill swarm runtime', 'CS_SKILL_SWARM_RUNTIME_INVALID');
  throw error;
}

  function mapSwarmIntelligenceError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'SWARM_INTELLIGENCE_SECRET_DETECTED') throw createError(400, 'swarm intelligence payload appears to contain a secret', 'SWARM_INTELLIGENCE_SECRET_DETECTED');
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
  const memoryCandidates = new MemoryCandidateService(db);
  const specialistPanels = new SpecialistPanelService(db);
  const intelligence = new SwarmIntelligenceService(db);
  const proofRuns = new ProofRunService(db);
  const csSkillSwarmHarness = new CsSkillSwarmHarnessService(db);

  // Nested spawn control endpoint (P1): POST /spawns/root, POST /spawns,
  // GET /spawns/:id/status. A spawned runtime child curls back here. The parent
  // /swarms mount already applies requireAuth; the child-spawn gate is the
  // scoped spawn token validated in NestedSpawnService.requestSpawn.
  router.use('/spawns', createSpawnRoutes(db, auth, wsService));

  router.get('/status', requirePermission('read:evidence'), (_req, res, next) => {
    try {
      res.json(service.getStatus());
    } catch (error) {
      next(error);
    }
  });

  router.post('/scheduler/tick', requirePermission('write:swarm_action'), (req, res, next) => {
    try {
      res.json(service.tickScheduler(req.body || {}));
    } catch (error) {
      next(error);
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

  router.get('/intelligence/mission-control', requirePermission('read:evidence'), (_req, res, next) => {
    try {
      res.json({
        ...intelligence.missionControl(),
        latest_proof_run: proofRuns.latest(),
      });
    } catch (error) {
      try {
        mapSwarmIntelligenceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/proof-runs', requirePermission('write:swarm_action'), async (req, res, next) => {
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

  router.post('/proof-runs/:id/rollback', requirePermission('write:swarm_action'), (req, res, next) => {
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

  router.get('/assurance/capability-tokens', requirePermission('read:evidence'), (req, res, next) => {
    try {
      res.json({ tokens: assurance.listCapabilityTokens(req.query.limit ? Number(req.query.limit) : undefined) });
    } catch (error) {
      next(error);
    }
  });

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

  router.get('/assurance/reflections', requirePermission('read:evidence'), (req, res, next) => {
    try {
      res.json({ reflections: assurance.listReflections(req.query.limit ? Number(req.query.limit) : undefined) });
    } catch (error) {
      next(error);
    }
  });

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

  router.get('/memory/candidates', requirePermission('read:evidence'), (req, res, next) => {
    try {
      res.json({ candidates: memoryCandidates.list(req.query.limit ? Number(req.query.limit) : undefined) });
    } catch (error) {
      next(error);
    }
  });

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

  router.get('/specialist-panels', requirePermission('read:evidence'), (req, res, next) => {
    try {
      res.json({ panels: specialistPanels.listPanels(req.query.limit ? Number(req.query.limit) : undefined) });
    } catch (error) {
      next(error);
    }
  });

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

  return router;
}
