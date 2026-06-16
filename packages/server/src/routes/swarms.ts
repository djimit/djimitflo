import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { createError } from '../middleware/error-handler';
import { AgentAssuranceService } from '../services/agent-assurance-service';
import { MemoryCandidateService } from '../services/memory-candidate-service';
import { SpecialistPanelService } from '../services/specialist-panel-service';
import { SwarmStatusService } from '../services/swarm-status-service';

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

export function createSwarmRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const service = new SwarmStatusService(db);
  const assurance = new AgentAssuranceService(db);
  const memoryCandidates = new MemoryCandidateService(db);
  const specialistPanels = new SpecialistPanelService(db);

  router.get('/status', requirePermission('read:evidence'), (_req, res, next) => {
    try {
      res.json(service.getStatus());
    } catch (error) {
      next(error);
    }
  });

  router.post('/scheduler/tick', requirePermission('create:task'), (req, res, next) => {
    try {
      res.json(service.tickScheduler(req.body || {}));
    } catch (error) {
      next(error);
    }
  });

  router.get('/assurance/summary', requirePermission('read:evidence'), (_req, res, next) => {
    try {
      res.json(assurance.summary());
    } catch (error) {
      next(error);
    }
  });

  router.post('/assurance/trace-spans', requirePermission('create:task'), (req, res, next) => {
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

  router.post('/assurance/checkpoints', requirePermission('create:task'), (req, res, next) => {
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

  router.post('/assurance/checkpoints/:id/branch', requirePermission('create:task'), (req, res, next) => {
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

  router.post('/assurance/evals/run', requirePermission('create:task'), (req, res, next) => {
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

  router.post('/assurance/capability-tokens', requirePermission('create:task'), (req, res, next) => {
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

  router.post('/assurance/reflections', requirePermission('create:task'), (req, res, next) => {
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

  router.post('/memory/candidates', requirePermission('create:task'), (req, res, next) => {
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

  router.post('/memory/candidates/:id/promote', requirePermission('create:task'), (req, res, next) => {
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

  router.post('/specialist-panels', requirePermission('create:task'), (req, res, next) => {
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

  router.post('/specialist-panels/:id/reviews', requirePermission('create:task'), (req, res, next) => {
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

  router.post('/specialist-panels/:id/backlog', requirePermission('create:task'), (req, res, next) => {
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
