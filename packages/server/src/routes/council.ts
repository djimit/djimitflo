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
  if (message === 'COUNCIL_SESSION_NOT_EXECUTABLE') throw createError(409, 'Council session is not executable', 'COUNCIL_SESSION_NOT_EXECUTABLE');
  if (message === 'COUNCIL_MODEL_NOT_FOUND') throw createError(404, 'Council model not found', 'COUNCIL_MODEL_NOT_FOUND');
  if (message === 'COUNCIL_NO_ACTIVE_MODELS') throw createError(503, 'No active models available for council', 'COUNCIL_NO_ACTIVE_MODELS');
  if (message === 'COUNCIL_NO_ELIGIBLE_MODELS') throw createError(503, 'No council models satisfy the requested constraints', 'COUNCIL_NO_ELIGIBLE_MODELS');
  if (message === 'COUNCIL_MODEL_PROVIDER_REQUIRED') throw createError(400, 'Model provider is required', 'COUNCIL_MODEL_PROVIDER_REQUIRED');
  if (message === 'COUNCIL_MODEL_NAME_REQUIRED') throw createError(400, 'Model name is required', 'COUNCIL_MODEL_NAME_REQUIRED');
  throw error;
}

const MODES = new Set(['fast', 'review', 'council']);
const RISKS = new Set(['low', 'medium', 'high', 'critical']);
const MODEL_STATUSES = new Set(['active', 'inactive', 'deprecated']);
const AGGREGATION_METHODS = new Set(['borda', 'weighted_borda', 'reciprocal_rank_fusion']);

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
      if (input.mode && !MODES.has(input.mode)) {
        throw createError(400, 'Invalid council mode', 'COUNCIL_MODE_INVALID');
      }
      if (input.risk_class && !RISKS.has(input.risk_class)) {
        throw createError(400, 'Invalid risk class', 'COUNCIL_RISK_CLASS_INVALID');
      }
      if (input.max_cost !== undefined && (typeof input.max_cost !== 'number' || !Number.isFinite(input.max_cost) || input.max_cost < 0)) {
        throw createError(400, 'max_cost must be a non-negative number', 'COUNCIL_MAX_COST_INVALID');
      }
      if (input.custom_models !== undefined && (!Array.isArray(input.custom_models) || input.custom_models.some(model => typeof model !== 'string' || !model.trim()))) {
        throw createError(400, 'custom_models must contain model names', 'COUNCIL_CUSTOM_MODELS_INVALID');
      }

      const session = await orchestrator.createSession(input);
      res.status(201).json(session);
    } catch (error) {
      mapCouncilError(error);
    }
  }));

  // GET /api/council/sessions — List council sessions
  router.get('/sessions', requirePermission('read:evidence'), route((_req, res) => {
    const limit = Math.max(1, Math.min(Number(_req.query.limit) || 50, 100));
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
      orchestrator.getSession(req.params.id);
      const evaluations = evaluator.getEvaluationsForSession(req.params.id);
      res.json(evaluations);
    } catch (error) {
      mapCouncilError(error);
    }
  }));

  // GET /api/council/sessions/:id/aggregate — Get aggregated scores
  router.get('/sessions/:id/aggregate', requirePermission('read:evidence'), route(async (req, res) => {
    try {
      const method = String(req.query.method || 'weighted_borda') as 'borda' | 'weighted_borda' | 'reciprocal_rank_fusion';
      if (!AGGREGATION_METHODS.has(method)) {
        throw createError(400, 'Invalid aggregation method', 'COUNCIL_AGGREGATION_METHOD_INVALID');
      }
      orchestrator.getSession(req.params.id);
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

      if (input.privacy_class && !new Set(['local', 'private_cloud', 'public_api']).has(input.privacy_class)) {
        throw createError(400, 'Invalid privacy class', 'COUNCIL_PRIVACY_CLASS_INVALID');
      }

      const model = registry.registerModel(input);
      res.status(201).json(model);
    } catch (error) {
      mapCouncilError(error);
    }
  }));

  // GET /api/council/models — List models
  router.get('/models', requirePermission('read:evidence'), route((_req, res) => {
    const status = _req.query.status as 'active' | 'inactive' | 'deprecated' | undefined;
    if (status && !MODEL_STATUSES.has(status)) {
      throw createError(400, 'Invalid model status', 'COUNCIL_MODEL_STATUS_INVALID');
    }
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
    if (typeof _req.body.description !== 'string' || !_req.body.description.trim()) {
      throw createError(400, 'description is required', 'COUNCIL_DESCRIPTION_REQUIRED');
    }
    if (_req.body.risk_class && !RISKS.has(_req.body.risk_class)) {
      throw createError(400, 'Invalid risk class', 'COUNCIL_RISK_CLASS_INVALID');
    }
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
