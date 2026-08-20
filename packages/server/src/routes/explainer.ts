/**
 * Explainer routes — REST API for explain_repo tasks.
 */

import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import type { Database } from "better-sqlite3";
import type { AuthMiddleware } from "../middleware/auth";
import { ExplainerGenerationService } from "../services/explainer-generation-service";
import { ExplainerDiscoveryService, type DiscoverySyncResult } from "../services/explainer-discovery-service";
import { RepoExplainerScheduler, type SchedulerStatus } from "../services/repo-explainer-scheduler";

export function createExplainerRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const service = new ExplainerGenerationService(db);
  const discovery = new ExplainerDiscoveryService(db);
  const scheduler = new RepoExplainerScheduler(db);

  // Public read rate limit for fleet status and published bundle listings.
  const publicReadLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false });

  // GET /api/explainer/tasks — list tasks
  router.get("/tasks", requirePermission("read:repository"), (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 100;
    const tasks = service.listTasks(Number.isFinite(limit) ? limit : 100, status);
    res.json({ tasks, count: tasks.length });
  });

  // POST /api/explainer/tasks — create a task
  router.post("/tasks", requirePermission("write:governance"), async (req, res) => {
    try {
      const task = await service.createTask(req.body);
      res.status(201).json(task);
    } catch (error) {
      res.status(400).json({ error: { message: error instanceof Error ? error.message : String(error), code: "VALIDATION_ERROR" } });
    }
  });

  // GET /api/explainer/tasks/:id — get a task
  router.get("/tasks/:id", requirePermission("read:repository"), (req, res) => {
    const task = service.getTask(req.params.id);
    if (!task) { res.status(404).json({ error: { message: "Task not found", code: "NOT_FOUND" } }); return; }
    res.json(task);
  });

  // POST /api/explainer/tasks/:id/run — run the pipeline
  router.post("/tasks/:id/run", requirePermission("write:governance"), async (req, res) => {
    try {
      const { skipGraph, skipEval, dryRun } = req.body || {};
      const bundlePath = await service.runPipeline(req.params.id, { skipGraph, skipEval, dryRun });
      res.json({ task_id: req.params.id, bundle_path: bundlePath });
    } catch (error) {
      res.status(500).json({ error: { message: error instanceof Error ? error.message : String(error) } });
    }
  });

  // GET /api/explainer/tasks/:id/bundles — list bundles for a task
  router.get("/tasks/:id/bundles", requirePermission("read:repository"), (req, res) => {
    const bundles = service.listBundles(req.params.id);
    res.json({ bundles, count: bundles.length });
  });

  // ─── Fleet endpoints (FR-020) ─────────────────────────────────────────────

  // GET /api/explainer/fleet/status — public read, rate-limited
  router.get("/fleet/status", publicReadLimiter, requirePermission("read:repository"), (_req, res) => {
    const status: SchedulerStatus = scheduler.getStatus();
    const repos = discovery.listDiscoveredRepositories(undefined, 1000);
    res.json({
      ...status,
      total_repositories: repos.length,
      active_repositories: repos.filter((r) => r.is_active).length,
    });
  });

  // POST /api/explainer/fleet/sync — auth mutation
  router.post("/fleet/sync", requirePermission("write:governance"), async (req, res) => {
    try {
      const owner = typeof req.body.owner === "string" ? req.body.owner : "djimit";
      const result: DiscoverySyncResult = await discovery.syncDiscoveredRepositories(owner);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: { message: error instanceof Error ? error.message : String(error), code: "DISCOVERY_ERROR" } });
    }
  });

  // GET /api/explainer/fleet/repos — list discovered repositories
  router.get("/fleet/repos", publicReadLimiter, requirePermission("read:repository"), (req, res) => {
    const owner = typeof req.query.owner === "string" ? req.query.owner : undefined;
    const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 1000;
    const repos = discovery.listDiscoveredRepositories(owner, Number.isFinite(limit) ? limit : 1000);
    res.json({ repositories: repos });
  });

  // POST /api/explainer/fleet/refresh-stale — auth mutation
  router.post("/fleet/refresh-stale", requirePermission("write:governance"), async (req, res) => {
    try {
      const owner = typeof req.body.owner === "string" ? req.body.owner : "djimit";
      const result = await scheduler.refreshStale(owner);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: { message: error instanceof Error ? error.message : String(error), code: "SCHEDULER_ERROR" } });
    }
  });

  // POST /api/explainer/fleet/run — run scheduler iteration
  router.post("/fleet/run", requirePermission("write:governance"), async (_req, res) => {
    try {
      const result = await scheduler.run();
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: { message: error instanceof Error ? error.message : String(error), code: "SCHEDULER_ERROR" } });
    }
  });

  // POST /api/explainer/fleet/pause — auth mutation
  router.post("/fleet/pause", requirePermission("write:governance"), (_req, res) => {
    scheduler.setPaused(true);
    res.json({ paused: scheduler.isPaused() });
  });

  // POST /api/explainer/fleet/resume — auth mutation
  router.post("/fleet/resume", requirePermission("write:governance"), (_req, res) => {
    scheduler.setPaused(false);
    res.json({ paused: scheduler.isPaused() });
  });

  return router;
}
