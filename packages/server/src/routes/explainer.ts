/**
 * Explainer routes — REST API for explain_repo tasks.
 */

import { Router } from "express";
import type { Database } from "better-sqlite3";
import type { AuthMiddleware } from "../middleware/auth";
import { ExplainerGenerationService } from "../services/explainer-generation-service";

export function createExplainerRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const service = new ExplainerGenerationService(db);

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

  return router;
}
