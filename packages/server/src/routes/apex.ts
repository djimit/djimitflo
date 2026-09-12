/**
 * Apex routes — next-level capabilities (plugins, vector memory, workers, LLM router).
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { PluginRegistryService } from '../services/plugin-registry-service';
import { VectorMemoryService } from '../services/vector-memory-service';
import { BackgroundWorkerService } from '../services/background-worker-service';
import { LlmRouterService } from '../services/llm-router-service';
import { lifecycleManager } from '../services/lifecycle-manager';
import { createError } from '../middleware/error-handler';

function boundedLimit(value: unknown): number {
  if (value === undefined) return 10;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw createError(400, 'limit must be an integer between 1 and 100', 'VALIDATION_ERROR');
  }
  return limit;
}

export function createApexRoutes(db: Database, auth?: AuthMiddleware, enableBackgroundWorkers = false): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  const plugins = new PluginRegistryService(db);
  const memory = new VectorMemoryService(db);
  const workers = new BackgroundWorkerService(db);
  const llm = new LlmRouterService(db);

  // SECURITY: background workers only start in operator/autonomous profile.
  // In api profile they would perform DB mutations (cleanup, archival) that
  // violate the mutation-free guarantee.
  if (enableBackgroundWorkers) {
    workers.startAll();
    lifecycleManager.register({
      serviceName: 'BackgroundWorkerService',
      stop: () => workers.stopAll(),
    });
  }

  // ─── Plugins ─────────────────────────────────────────────────────────
  router.get('/plugins', requirePermission('read:evidence'), (_req, res) => {
    res.json({ plugins: plugins.listPlugins() });
  });

  router.get('/plugins/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(plugins.getStats());
  });

  router.post('/plugins/:id/enable', requirePermission('manage:config'), (_req, res) => {
    res.status(503).json({ error: { code: 'PLUGIN_ACTIVATION_UNAVAILABLE', message: 'No shared trusted runtime plugin activation mechanism is configured; inventory flags are not activation.' } });
  });

  router.post('/plugins/:id/disable', requirePermission('manage:config'), (_req, res) => {
    res.status(503).json({ error: { code: 'PLUGIN_ACTIVATION_UNAVAILABLE', message: 'No shared runtime plugin deactivation mechanism is configured; inventory flags do not stop execution.' } });
  });

  // ─── Vector Memory ───────────────────────────────────────────────────
  router.post('/memory/store', requirePermission('write:claim'), async (req, res, next) => {
    const { content, metadata, ttl } = req.body;
    if (!content) {
      res.status(400).json({ error: { message: 'content is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    try {
      const vector = await memory.storeMemory({ content, metadata, ttl });
      res.status(201).json(vector);
    } catch (error) {
      next(error);
    }
  });

  router.get('/memory/search', requirePermission('read:evidence'), async (req, res, next) => {
    const q = req.query.q as string;
    let limit: number;
    try {
      limit = boundedLimit(req.query.limit);
    } catch (error) {
      next(error);
      return;
    }
    if (!q) {
      res.status(400).json({ error: { message: 'q parameter is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    try {
      res.json({ results: await memory.search(q, limit) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/memory/clusters', requirePermission('read:evidence'), async (_req, res, next) => {
    try {
      res.json({ clusters: await memory.getClusters() });
    } catch (error) {
      next(error);
    }
  });

  router.get('/memory/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(memory.getStats());
  });

  // ─── Background Workers ──────────────────────────────────────────────
  router.get('/workers/status', requirePermission('read:evidence'), (_req, res) => {
    res.json(workers.getStatus());
  });

  router.post('/workers/:id/run', requirePermission('manage:config'), requirePermission('execute:task'), async (req, res, next) => {
    try {
      const result = await workers.runWorker(req.params.id);
      res.json(result);
    } catch (error) {
      if (error instanceof Error && /^Worker not found:/.test(error.message)) {
        next(createError(404, error.message, 'WORKER_NOT_FOUND'));
        return;
      }
      next(error);
    }
  });

  router.post('/workers/:id/start', requirePermission('manage:config'), requirePermission('execute:task'), (req, res, next) => {
    try {
      workers.startWorker(req.params.id);
      res.json({ started: true });
    } catch (error) {
      if (error instanceof Error && /^Worker not found:/.test(error.message)) {
        next(createError(404, error.message, 'WORKER_NOT_FOUND'));
        return;
      }
      next(error);
    }
  });

  router.post('/workers/:id/stop', requirePermission('manage:config'), (req, res, next) => {
    try {
      workers.stopWorker(req.params.id);
      res.json({ stopped: true });
    } catch (error) {
      if (error instanceof Error && /^Worker not found:/.test(error.message)) {
        next(createError(404, error.message, 'WORKER_NOT_FOUND'));
        return;
      }
      next(error);
    }
  });

  // ─── LLM Router ──────────────────────────────────────────────────────
  router.post('/llm/route', requirePermission('read:evidence'), async (req, res, next) => {
    try {
      const request = req.body || {};
      const taskTypes = ['coding', 'analysis', 'creative', 'reasoning', 'chat', 'embedding'];
      if (!taskTypes.includes(request.taskType) || typeof request.prompt !== 'string' || !request.prompt.trim()) {
        res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'taskType and prompt are required' } });
        return;
      }
      await llm.refreshProviderHealth();
      res.json(llm.route(request));
    } catch (error) {
      next(error);
    }
  });

  router.get('/llm/providers', requirePermission('read:evidence'), async (_req, res) => {
    res.json({ providers: await llm.refreshProviderHealth() });
  });

  router.get('/llm/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(llm.getStats());
  });

  router.post('/llm/performance', requirePermission('write:evidence'), (req, res) => {
    const { provider, taskType, success, latencyMs, costDollars } = req.body;
    if (!['anthropic', 'openai', 'google', 'ollama', 'litellm'].includes(provider)
      || typeof taskType !== 'string' || !taskType.trim() || typeof success !== 'boolean'
      || !Number.isFinite(latencyMs) || latencyMs < 0
      || (costDollars !== undefined && (!Number.isFinite(costDollars) || costDollars < 0))) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Valid provider, taskType, boolean success and nonnegative numeric metrics are required' } });
      return;
    }
    llm.recordPerformance(req.body);
    res.json({ recorded: true });
  });

  return router;
}
