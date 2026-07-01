import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { createError } from '../middleware/error-handler';
import { WorkItemService } from '../services/work-item-service';
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
      res.json(service.update(req.params.id, req.body || {}));
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
