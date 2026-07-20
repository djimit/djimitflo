import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { createError } from '../middleware/error-handler';
import { CouncilOrchestrator, type CouncilCreateInput } from '../services/council-orchestrator';
import { CouncilRegistry, type CouncilModelInput } from '../services/council-registry';
import { StructuredEvaluator } from '../services/structured-evaluator';
import { TaskRouter } from '../services/task-router';

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

function mapCouncilError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'COUNCIL_SESSION_NOT_FOUND') throw createError(404, 'Council session not found', 'COUNCIL_SESSION_NOT_FOUND');
  if (message === 'COUNCIL_MODEL_NOT_FOUND') throw createError(404, 'Council model not found', 'COUNCIL_MODEL_NOT_FOUND');
  if (message === 'COUNCIL_NO_ACTIVE_MODELS') throw createError(503, 'No active models available for council', 'COUNCIL_NO_ACTIVE_MODELS');
  if (message === 'COUNCIL_MODEL_PROVIDER_REQUIRED') throw createError(400, 'Model provider is required', 'COUNCIL_MODEL_PROVIDER_REQUIRED');
  if (message === 'COUNCIL_MODEL_NAME_REQUIRED') throw createError(400, 'Model name is required', 'COUNCIL_MODEL_NAME_REQUIRED');
  throw error;
}

export function createCouncilRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  const orchestrator = new CouncilOrchestrator(db);
  const registry = new CouncilRegistry(db);
  const evaluator = new StructuredEvaluator(db);
  const router_ = new TaskRouter();

  // ═══════════════════════════════════════════════════════════════
  // COUNCIL SESSIONS
  // ═══════════════════════════════════════════════════════════════

  // POST /api/council/sessions — Create a new council session
  router.post('/sessions', requirePermission('write:governance'), route(async (req, res) => {
    try {
      const input: CouncilCreateInput = {
        task_description: req.body.task_description,
        task_id: req.body.task_id,
        mode: req.body.mode,
        risk_class: req.body.risk_class,
        privacy_sensitive: req.body.privacy_sensitive,
        realtime: req.body.realtime,
        max_cost: req.body.max_cost,
        custom_models: req.body.custom_models,
      };

      if (!input.task_description?.trim()) {
        throw createError(400, 'task_description is required', 'COUNCIL_TASK_DESCRIPTION_REQUIRED');
      }

      const session = await orchestrator.createSession(input);
      res.status(201).json(session);
    } catch (error) {
      mapCouncilError(error);
    }
  }));

  // GET /api/council/sessions — List council sessions
  router.get('/sessions', requirePermission('read:evidence'), route((_req, res) => {
    const limit = Math.min(Number(_req.query.limit) || 50, 100);
    const sessions = orchestrator.listSessions(limit);
    res.json(sessions);
  }));

  // GET /api/council/sessions/:id — Get session details
  router.get('/sessions/:id', requirePermission('read:evidence'), route(async (req, res) => {
    try {
      const status = orchestrator.getSessionStatus(req.params.id);
      res.json(status);
    } catch (error) {
      mapCouncilError(error);
    }
  }));

  // POST /api/council/sessions/:id/execute — Execute council session
  router.post('/sessions/:id/execute', requirePermission('write:governance'), route(async (req, res) => {
    try {
      const result = await orchestrator.executeCouncil(req.params.id);
      res.json(result);
    } catch (error) {
      mapCouncilError(error);
    }
  }));

  // GET /api/council/sessions/:id/outputs — Get session outputs
  router.get('/sessions/:id/outputs', requirePermission('read:evidence'), route(async (req, res) => {
    try {
      const outputs = orchestrator.getSessionOutputs(req.params.id);
      res.json(outputs);
    } catch (error) {
      mapCouncilError(error);
    }
  }));

  // GET /api/council/sessions/:id/evaluations — Get session evaluations
  router.get('/sessions/:id/evaluations', requirePermission('read:evidence'), route(async (req, res) => {
    try {
      const evaluations = evaluator.getEvaluationsForSession(req.params.id);
      res.json(evaluations);
    } catch (error) {
      mapCouncilError(error);
    }
  }));

  // GET /api/council/sessions/:id/aggregate — Get aggregated scores
  router.get('/sessions/:id/aggregate', requirePermission('read:evidence'), route(async (req, res) => {
    try {
      const method = (req.query.method as 'borda' | 'weighted_borda' | 'reciprocal_rank_fusion') || 'weighted_borda';
      const aggregated = evaluator.aggregateScores(req.params.id, method);
      const disagreement = evaluator.calculateDisagreement(req.params.id);
      res.json({ aggregated, disagreement, method });
    } catch (error) {
      mapCouncilError(error);
    }
  }));

  // ═══════════════════════════════════════════════════════════════
  // COUNCIL MODELS
  // ═══════════════════════════════════════════════════════════════

  // POST /api/council/models — Register a model
  router.post('/models', requirePermission('write:capability'), route(async (req, res) => {
    try {
      const input: CouncilModelInput = {
        provider: req.body.provider,
        model_name: req.body.model_name,
        capabilities: req.body.capabilities,
        reasoning_depth: req.body.reasoning_depth,
        cost_per_1m_tokens: req.body.cost_per_1m_tokens,
        privacy_class: req.body.privacy_class,
        independence_score: req.body.independence_score,
        avg_governance_score: req.body.avg_governance_score,
        metadata: req.body.metadata,
      };

      const model = registry.registerModel(input);
      res.status(201).json(model);
    } catch (error) {
      mapCouncilError(error);
    }
  }));

  // GET /api/council/models — List models
  router.get('/models', requirePermission('read:evidence'), route((_req, res) => {
    const status = _req.query.status as 'active' | 'inactive' | 'deprecated' | undefined;
    const models = registry.listModels(status);
    res.json(models);
  }));

  // GET /api/council/models/:id — Get model details
  router.get('/models/:id', requirePermission('read:evidence'), route(async (req, res) => {
    try {
      const model = registry.getModel(req.params.id);
      res.json(model);
    } catch (error) {
      mapCouncilError(error);
    }
  }));

  // DELETE /api/council/models/:id — Deprecate a model
  router.delete('/models/:id', requirePermission('write:capability'), route(async (req, res) => {
    try {
      registry.deprecateModel(req.params.id);
      res.json({ success: true, message: 'Model deprecated' });
    } catch (error) {
      mapCouncilError(error);
    }
  }));

  // ═══════════════════════════════════════════════════════════════
  // TASK ROUTER
  // ═══════════════════════════════════════════════════════════════

  // POST /api/council/classify — Classify a task
  router.post('/classify', requirePermission('read:evidence'), route((_req, res) => {
    const classification = router_.classify({
      description: _req.body.description,
      risk_class: _req.body.risk_class,
      domains: _req.body.domains,
      privacy_sensitive: _req.body.privacy_sensitive,
      realtime: _req.body.realtime,
      budget_constraint: _req.body.budget_constraint,
    });
    res.json(classification);
  }));

  // ═══════════════════════════════════════════════════════════════
  // COUNCIL STATS
  // ═══════════════════════════════════════════════════════════════

  // GET /api/council/stats — Council statistics
  router.get('/stats', requirePermission('read:evidence'), route((_req, res) => {
    const activeModels = registry.listModels('active');
    const allSessions = orchestrator.listSessions(1000);

    const stats = {
      models: {
        total: activeModels.length,
        active: activeModels.filter(m => m.status === 'active').length,
        by_provider: activeModels.reduce((acc, m) => {
          acc[m.provider] = (acc[m.provider] || 0) + 1;
          return acc;
        }, {} as Record<string, number>),
        by_privacy: activeModels.reduce((acc, m) => {
          acc[m.privacy_class] = (acc[m.privacy_class] || 0) + 1;
          return acc;
        }, {} as Record<string, number>),
      },
      sessions: {
        total: allSessions.length,
        completed: allSessions.filter(s => s.status === 'completed').length,
        failed: allSessions.filter(s => s.status === 'failed').length,
        escalated: allSessions.filter(s => s.status === 'escalated').length,
        by_mode: allSessions.reduce((acc, s) => {
          acc[s.mode] = (acc[s.mode] || 0) + 1;
          return acc;
        }, {} as Record<string, number>),
      },
      avg_diversity_score: activeModels.length > 1
        ? Math.round(activeModels.reduce((s, m) => s + m.independence_score, 0) / activeModels.length * 100) / 100
        : 0,
    };

    res.json(stats);
  }));

  return router;
}
