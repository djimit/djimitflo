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

export function createApexRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  const plugins = new PluginRegistryService(db);
  const memory = new VectorMemoryService(db);
  const workers = new BackgroundWorkerService(db);
  const llm = new LlmRouterService(db);

  // Start background workers
  workers.startAll();

  // ─── Plugins ─────────────────────────────────────────────────────────
  router.get('/plugins', requirePermission('read:evidence'), (_req, res) => {
    res.json({ plugins: plugins.listPlugins() });
  });

  router.get('/plugins/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(plugins.getStats());
  });

  router.post('/plugins/:id/enable', requirePermission('write:config'), (req, res) => {
    const success = plugins.enablePlugin(req.params.id);
    res.json({ success });
  });

  router.post('/plugins/:id/disable', requirePermission('write:config'), (req, res) => {
    const success = plugins.disablePlugin(req.params.id);
    res.json({ success });
  });

  // ─── Vector Memory ───────────────────────────────────────────────────
  router.post('/memory/store', requirePermission('write:claim'), (req, res) => {
    const { content, metadata, ttl } = req.body;
    if (!content) {
      res.status(400).json({ error: { message: 'content is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const vector = memory.storeMemory({ content, metadata, ttl });
    res.status(201).json(vector);
  });

  router.get('/memory/search', requirePermission('read:evidence'), (req, res) => {
    const q = req.query.q as string;
    const limit = req.query.limit ? Number(req.query.limit) : 10;
    if (!q) {
      res.status(400).json({ error: { message: 'q parameter is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    res.json({ results: memory.search(q, limit) });
  });

  router.get('/memory/clusters', requirePermission('read:evidence'), (_req, res) => {
    res.json({ clusters: memory.getClusters() });
  });

  router.get('/memory/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(memory.getStats());
  });

  // ─── Background Workers ──────────────────────────────────────────────
  router.get('/workers/status', requirePermission('read:evidence'), (_req, res) => {
    res.json(workers.getStatus());
  });

  router.post('/workers/:id/run', requirePermission('write:config'), async (req, res) => {
    const result = await workers.runWorker(req.params.id);
    res.json(result);
  });

  router.post('/workers/:id/start', requirePermission('write:config'), (req, res) => {
    workers.startWorker(req.params.id);
    res.json({ started: true });
  });

  router.post('/workers/:id/stop', requirePermission('write:config'), (req, res) => {
    workers.stopWorker(req.params.id);
    res.json({ stopped: true });
  });

  // ─── LLM Router ──────────────────────────────────────────────────────
  router.post('/llm/route', requirePermission('read:evidence'), async (req, res, next) => {
    try {
      await llm.refreshProviderHealth();
      res.json(llm.route(req.body));
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

  router.post('/llm/performance', requirePermission('write:config'), (req, res) => {
    llm.recordPerformance(req.body);
    res.json({ recorded: true });
  });

  return router;
}
