import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { createError } from '../middleware/error-handler';
import { SECURITY_FINDING_SOURCE, WorkItemService } from '../services/work-item-service';
import { IntegrationInboxService } from '../services/integration-inbox-service';

function mapWorkItemError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'WORK_ITEM_NOT_FOUND') throw createError(404, 'Work item not found', 'WORK_ITEM_NOT_FOUND');
  if (message === 'WORK_ITEM_TITLE_REQUIRED') throw createError(400, 'title is required', 'WORK_ITEM_TITLE_REQUIRED');
  if (message === 'WORK_ITEM_DESCRIPTION_REQUIRED') throw createError(400, 'description is required', 'WORK_ITEM_DESCRIPTION_REQUIRED');
  if (message === 'WORK_ITEM_RISK_INVALID') throw createError(400, 'risk_class is invalid', 'WORK_ITEM_RISK_INVALID');
  if (message === 'WORK_ITEM_STATUS_INVALID') throw createError(400, 'status is invalid', 'WORK_ITEM_STATUS_INVALID');
  if (message === 'WORK_ITEM_NUMERIC_RANGE_INVALID') throw createError(400, 'value_score/confidence is out of range', 'WORK_ITEM_NUMERIC_RANGE_INVALID');
  if (message === 'INTEGRATION_SOURCE_INVALID') throw createError(400, 'source is invalid', 'INTEGRATION_SOURCE_INVALID');
  if (message === 'INTEGRATION_TITLE_REQUIRED') throw createError(400, 'title is required', 'INTEGRATION_TITLE_REQUIRED');
  if (message === 'INTEGRATION_DESCRIPTION_REQUIRED') throw createError(400, 'description is required', 'INTEGRATION_DESCRIPTION_REQUIRED');
  if (message === 'INTEGRATION_RISK_INVALID') throw createError(400, 'risk_class is invalid', 'INTEGRATION_RISK_INVALID');
  if (message === 'INTEGRATION_LOOP_INVALID') throw createError(400, 'recommended_loop is invalid', 'INTEGRATION_LOOP_INVALID');
  if (message.startsWith('SECURITY_FINDING_CONTRACT_INCOMPLETE:')) {
    throw createError(400, message.split(':')[1] || 'security metadata is incomplete', 'SECURITY_FINDING_CONTRACT_INCOMPLETE');
  }
  if (message === 'SECURITY_FINDING_SEVERITY_INVALID') throw createError(400, 'security severity is invalid', message);
  if (message === 'SECURITY_FINDING_CIA_IMPACT_INVALID') throw createError(400, 'cia_impact is invalid', message);
  if (message === 'SECURITY_FINDING_IDENTITY_INVALID') throw createError(400, 'security finding identity is invalid', message);
  if (message === 'SECURITY_FINDING_RISK_MISMATCH') throw createError(400, 'risk_class must match security severity', message);
  if (message === 'SECURITY_FINDING_LOOP_REQUIRED') throw createError(400, 'security-regression-loop is required', message);
  if (message === 'SECURITY_FINDING_IMPORT_REQUIRED') throw createError(400, 'security findings must use the integration import boundary', message);
  if (message === 'SECURITY_FINDING_TERMINAL_CREATE_FORBIDDEN') throw createError(409, 'security findings cannot be created in a terminal state', message);
  if (message === 'SECURITY_FINDING_RISK_DOWNGRADE_FORBIDDEN') throw createError(409, 'security finding risk cannot be downgraded in place', message);
  if (message === 'SECURITY_FINDING_REOPEN_IMPORT_REQUIRED') throw createError(409, 'terminal security findings can only reopen through recurrent scanner import', message);
  if (message === 'SECURITY_FINDING_REPLAY_CONFLICT') throw createError(409, 'scanner replay identity conflicts with its prior payload', message);
  if (message === 'SECURITY_FINDING_PROVENANCE_IMMUTABLE') throw createError(409, 'scanner provenance can only change through scanner import', message);
  if (message === 'SECURITY_FINDING_TERMINAL_STATE_IMMUTABLE') throw createError(409, 'terminal security finding state is immutable', message);
  if (message === 'SECURITY_FINDING_RESOLUTION_IMMUTABLE') throw createError(409, 'terminal security finding resolution is immutable', message);
  if (message === 'SECURITY_FINDING_HISTORY_IMMUTABLE') throw createError(409, 'security finding resolution history is immutable', message);
  if (message === 'SECURITY_FINDING_CLOSURE_EVIDENCE_REQUIRED') throw createError(409, 'security finding closure evidence is required', message);
  if (message === 'SECURITY_FINDING_LOOP_EVIDENCE_REQUIRED') throw createError(409, 'a completed, gated security-regression-loop for this finding is required', message);
  if (message === 'SECURITY_FINDING_DISPOSITION_EVIDENCE_REQUIRED') throw createError(409, 'security finding disposition evidence is required', message);
  if (message === 'SECURITY_FINDING_INDEPENDENT_REVIEW_REQUIRED') throw createError(409, 'high-risk security findings require independent review and human approval', message);
  if (message === 'SECURITY_FINDING_APPROVER_IDENTITY_REQUIRED') throw createError(401, 'authenticated approver identity is required', message);
  throw error;
}

export function createWorkItemRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const service = new WorkItemService(db);
  const integrationInbox = new IntegrationInboxService(db);

  router.get('/', requirePermission('read:evidence'), (req, res, next) => {
    try {
      res.json({
        work_items: service.list({
          status: req.query.status as string | undefined,
          limit: req.query.limit ? Number(req.query.limit) : undefined,
        }),
      });
    } catch (error) {
      try {
        mapWorkItemError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/', requirePermission('create:task'), (req, res, next) => {
    try {
      res.status(201).json(service.create(req.body || {}));
    } catch (error) {
      try {
        mapWorkItemError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/integrations/preview', requirePermission('create:task'), (req, res, next) => {
    try {
      res.json(integrationInbox.preview(req.body || {}));
    } catch (error) {
      try {
        mapWorkItemError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/integrations/import', requirePermission('create:task'), (req, res, next) => {
    try {
      const result = integrationInbox.importEvent(req.body || {});
      res.status(result.created ? 201 : 200).json(result);
    } catch (error) {
      try {
        mapWorkItemError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.get('/:id', requirePermission('read:evidence'), (req, res, next) => {
    try {
      res.json(service.get(req.params.id));
    } catch (error) {
      try {
        mapWorkItemError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.patch('/:id', requirePermission('create:task'), (req, res, next) => {
    try {
      const item = service.get(req.params.id);
      const effectiveRisk = req.body?.risk_class ?? item.risk_class;
      const terminalHighRiskSecurityFinding = item.source === SECURITY_FINDING_SOURCE
        && (effectiveRisk === 'high' || effectiveRisk === 'critical')
        && (req.body?.status === 'done' || req.body?.status === 'discarded');
      if (terminalHighRiskSecurityFinding) {
        requirePermission('approve:task')(req, res, next);
        return;
      }
      next();
    } catch (error) {
      try {
        mapWorkItemError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  }, (req, res, next) => {
    try {
      const existing = service.get(req.params.id);
      let input = req.body || {};
      const effectiveRisk = input.risk_class ?? existing.risk_class;
      if (existing.source === SECURITY_FINDING_SOURCE
        && (effectiveRisk === 'high' || effectiveRisk === 'critical')
        && (input.status === 'done' || input.status === 'discarded')) {
        const actor = req.user?.sub || req.user?.email;
        if (!actor) throw new Error('SECURITY_FINDING_APPROVER_IDENTITY_REQUIRED');
        const existingSecurity = existing.metadata?.security as Record<string, unknown> | undefined;
        const security = input.metadata?.security as Record<string, unknown> | undefined;
        const resolutionKey = input.status === 'done' ? 'closure' : 'disposition';
        const resolution = security?.[resolutionKey] as Record<string, unknown> | undefined;
        input = {
          ...input,
          metadata: {
            ...existing.metadata,
            ...(input.metadata || {}),
            security: {
              ...(existingSecurity || {}),
              ...(security || {}),
              [resolutionKey]: {
                ...(resolution || {}),
                human_approval_ref: `operator:${actor}`,
              },
            },
          },
        };
      }
      res.json(service.update(req.params.id, input));
    } catch (error) {
      try {
        mapWorkItemError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/:id/convert-to-goal', requirePermission('create:task'), (req, res, next) => {
    try {
      res.status(201).json(service.convertToGoal(req.params.id));
    } catch (error) {
      try {
        mapWorkItemError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  return router;
}
