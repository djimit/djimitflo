/**
 * Explainer routes — REST API for explain_repo tasks.
 */

import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { randomUUID } from "crypto";
import type { Database } from "better-sqlite3";
import type { AuthMiddleware } from "../middleware/auth";
import { ExplainerGenerationService } from "../services/explainer-generation-service";
import { ExplainerDiscoveryService, type DiscoverySyncResult } from "../services/explainer-discovery-service";
import { RepoExplainerScheduler, type SchedulerStatus } from "../services/repo-explainer-scheduler";
import { ExplainerProvider } from "@djimitflo/shared";
import { ExplainerKnowledgeService } from "../services/explainer-knowledge-service";
import { ExplainerAskService } from "../services/explainer-ask-service";

export function createExplainerRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const service = new ExplainerGenerationService(db);
  const discovery = new ExplainerDiscoveryService(db);
  const scheduler = new RepoExplainerScheduler(db);

  // Public read rate limit for fleet status and published bundle listings.
  const publicReadLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false });
  // Strikter limiter voor mutaties en zware DB-reads (CodeQL js/missing-rate-limiting).
  const mutationLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });
  const heavyReadLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });

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

  // GET /api/explainer/fleet/overview — repo matrix with latest bundle score, freshness, health
  router.get("/fleet/overview", publicReadLimiter, requirePermission("read:repository"), (req, res) => {
    const owner = typeof req.query.owner === "string" ? req.query.owner : "djimit";
    const repos = discovery.listDiscoveredRepositories(owner, 1000) as any[];
    const now = Date.now();
    const overview = repos.map((repo) => {
      const bundle = db.prepare(
        `SELECT b.openmythos_score, b.updated_at, b.created_at, t.status AS task_status, t.id AS task_id
         FROM explainer_tasks t
         LEFT JOIN explainer_bundles b ON b.id = (
           SELECT id FROM explainer_bundles WHERE task_id = t.id ORDER BY created_at DESC LIMIT 1
         )
         WHERE t.discovered_repository_id = ?
         ORDER BY b.created_at DESC
         LIMIT 1`,
      ).get(repo.id) as any;
      const lastGenerated = bundle?.created_at ?? null;
      const ageDays = lastGenerated ? (now - new Date(lastGenerated).getTime()) / 86_400_000 : null;
      const scan = db.prepare(
        `SELECT health_score FROM repositories WHERE full_name = ?`,
      ).get(repo.full_name) as any;
      return {
        ...repo,
        last_generated: lastGenerated,
        age_days: ageDays === null ? null : Math.round(ageDays * 10) / 10,
        openmythos_score: bundle?.openmythos_score ?? null,
        task_status: bundle?.task_status ?? null,
        task_id: bundle?.task_id ?? null,
        health_score: scan?.health_score ?? null,
        fresh: ageDays !== null && ageDays <= 7,
      };
    });
    res.json({ repositories: overview });
  });

  // POST /api/explainer/fleet/regenerate — enqueue regeneration for one repo (auth mutation)
  router.post("/fleet/regenerate", mutationLimiter, requirePermission("write:governance"), async (req, res) => {
    try {
      const { full_name: fullName } = req.body || {};
      if (typeof fullName !== "string" || !fullName.includes("/")) {
        res.status(400).json({ error: { message: "full_name required (owner/name)", code: "VALIDATION_ERROR" } });
        return;
      }
      const discovered = db.prepare("SELECT id FROM discovered_repositories WHERE full_name = ?").get(fullName) as any;
      if (!discovered) {
        res.status(404).json({ error: { message: "Repository not discovered", code: "NOT_FOUND" } });
        return;
      }
      const task = await service.createTask({
        title: `Regenerate explainer: ${fullName}`,
        provider: ExplainerProvider.GITHUB,
        remote_url: `https://github.com/${fullName}.git`,
        discovered_repository_id: discovered.id,
      });
      const bundlePath = await service.runPipeline(task.id);
      res.json({ task_id: task.id, bundle_path: bundlePath });
    } catch (error) {
      res.status(500).json({ error: { message: error instanceof Error ? error.message : String(error), code: "PIPELINE_ERROR" } });
    }
  });

  // ─── Knowledge pack (FR-021/FR-022/FR-023) ────────────────────────────────

  const knowledge = new ExplainerKnowledgeService(db);

  // POST /api/explainer/knowledge/sync — chunk + embed published bundles (auth mutation)
  router.post("/knowledge/sync", mutationLimiter, requirePermission("write:governance"), async (_req, res) => {
    try {
      const bundles = db.prepare("SELECT id FROM explainer_bundles WHERE status = 'published' ORDER BY created_at DESC LIMIT 100").all() as any[];
      let embedded = 0;
      let qdrantAvailable = false;
      let chunkCount = 0;
      for (const bundle of bundles) {
        const chunks = knowledge.chunkBundle(bundle.id);
        chunkCount += chunks.length;
        const result = await knowledge.embedChunks(chunks);
        embedded += result.embedded;
        qdrantAvailable = qdrantAvailable || result.qdrant_available;
      }
      res.json({ bundles: bundles.length, chunks: chunkCount, embedded, qdrant_available: qdrantAvailable });
    } catch (error) {
      res.status(500).json({ error: { message: error instanceof Error ? error.message : String(error), code: "KNOWLEDGE_SYNC_ERROR" } });
    }
  });

  // GET /api/explainer/knowledge/search — ranked citation-linked chunks (public read, rate-limited)
  router.get("/knowledge/search", publicReadLimiter, requirePermission("read:repository"), async (req, res) => {
    try {
      const query = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim() : "";
      if (!query) {
        res.status(400).json({ error: { message: "Query parameter q required", code: "VALIDATION_ERROR" } });
        return;
      }
      const repo = typeof req.query.repo === "string" ? req.query.repo : undefined;
      const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 10;
      const { results, degraded } = await knowledge.search(query, {
        repo,
        limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : 10,
      });
      res.json({
        query,
        degraded,
        results: results.map((r) => ({
          repo: r.chunk.repo_full_name,
          chunk_type: r.chunk.chunk_type,
          section: r.chunk.section,
          text: r.chunk.text,
          citation: r.chunk.citation,
          file_path: r.chunk.file_path,
          line_start: r.chunk.line_start,
          line_end: r.chunk.line_end,
          bundle_version: r.chunk.bundle_version,
          valid_until: r.chunk.valid_until,
          score: r.score,
          source: r.source,
        })),
      });
    } catch (error) {
      res.status(500).json({ error: { message: error instanceof Error ? error.message : String(error), code: "KNOWLEDGE_SEARCH_ERROR" } });
    }
  });

  // GET /api/explainer/knowledge/fact/:id — one fact with citation
  router.get("/knowledge/fact/:id", publicReadLimiter, requirePermission("read:repository"), (req, res) => {
    const fact = knowledge.getFact(req.params.id);
    if (!fact) {
      res.status(404).json({ error: { message: "Fact not found", code: "NOT_FOUND" } });
      return;
    }
    res.json(fact.chunk);
  });

  // GET /api/explainer/knowledge/repos — repos with published knowledge
  router.get("/knowledge/repos", publicReadLimiter, requirePermission("read:repository"), (_req, res) => {
    res.json({ repositories: knowledge.listKnowledgeRepos() });
  });

  // GET /api/explainer/knowledge/manifest/:owner/:repo — per-repo MCP server manifest (FR-024)
  router.get("/knowledge/manifest/:owner/:repo", publicReadLimiter, requirePermission("read:repository"), (req, res) => {
    const { owner, repo } = req.params;
    const fullName = `${owner}/${repo}`;
    const published = db.prepare(
      `SELECT b.id FROM explainer_bundles b JOIN explainer_tasks t ON t.id = b.task_id
       LEFT JOIN discovered_repositories dr ON dr.id = t.discovered_repository_id
       WHERE b.status = 'published' AND dr.full_name = ? LIMIT 1`,
    ).get(fullName) as any;
    if (!published) {
      res.status(404).json({ error: { message: `No published explainer for ${fullName}`, code: "NOT_FOUND" } });
      return;
    }
    const origin = process.env.DJIMITFLO_PUBLIC_ORIGIN || `http://localhost:${process.env.PORT || 3001}`;
    const manifest = {
      name: `djimit-explainer-${repo}`,
      version: "1.0.0",
      description: `Repo knowledge source for ${fullName} (Djimit Explore)`,
      knowledge_sources: [
        {
          type: "rest",
          search_url: `${origin}/api/explainer/knowledge/search?repo=${encodeURIComponent(fullName)}&q={query}`,
          fact_url: `${origin}/api/explainer/knowledge/fact/{fact_id}`,
          llms_txt: `${origin}/explore/${owner}/${repo}/llms.txt`,
        },
      ],
      tools: ["explainer_search_repo", "explainer_get_fact", "explainer_compare_repos"],
      freshness: "valid_until per chunk; refreshed on pipeline run",
      license_notice: "AI-generated content — verify claims against the source repository.",
    };
    res.json(manifest);
  });

  // ─── Operations & governance (FR-015/FR-019/FR-020) ───────────────────────

  // POST /api/explainer/bundles/:id/unpublish — EC-005: pull misleading content fast
  router.post("/bundles/:id/unpublish", mutationLimiter, requirePermission("write:governance"), async (req, res) => {
    const bundleId = req.params.id;
    const row = db.prepare("SELECT id, status FROM explainer_bundles WHERE id = ?").get(bundleId) as any;
    if (!row) {
      res.status(404).json({ error: { message: "Bundle not found", code: "NOT_FOUND" } });
      return;
    }
    db.prepare("UPDATE explainer_bundles SET status = 'unpublished', updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      bundleId,
    );
    // EC-005 hardening: also purge the bundle's knowledge-pack points so the
    // content disappears from semantic search and grounded Q&A, not just SQLite.
    let qdrantPurged = false;
    try {
      qdrantPurged = await knowledge.deleteBundleChunks(bundleId);
    } catch {
      // best-effort; warn below when not purged
    }
    db.prepare(
      "INSERT INTO explainer_audit_log (id, actor, action, resource_type, resource_id, outcome, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      randomUUID(),
      (req as any).user?.sub ?? "operator",
      "bundle_unpublish",
      "explainer_bundle",
      bundleId,
      "success",
      typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : null,
      new Date().toISOString(),
    );
    if (!qdrantPurged) {
      console.warn(`⚠️  Unpublished bundle ${bundleId}: Qdrant points NOT purged (unavailable?) — semantic search may still serve cached chunks.`);
    }
    res.json({ id: bundleId, status: "unpublished", qdrant_purged: qdrantPurged });
  });

  // POST /api/explainer/fleet/kill-switch — halt all scheduling + pause workers
  router.post("/fleet/kill-switch", mutationLimiter, requirePermission("write:governance"), (req, res) => {
    scheduler.setPaused(true);
    db.prepare("UPDATE explainer_jobs SET status = 'cancelled', updated_at = ? WHERE status IN ('pending', 'queued')").run(
      new Date().toISOString(),
    );
    db.prepare(
      "INSERT INTO explainer_audit_log (id, actor, action, resource_type, resource_id, outcome, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      randomUUID(),
      (req as any).user?.sub ?? "operator",
      "fleet_kill_switch",
      "explainer_fleet",
      "all",
      "success",
      typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : "Kill switch engaged",
      new Date().toISOString(),
    );
    res.json({ paused: true, pending_cancelled: true });
  });

  // GET /api/explainer/audit — recent audit log entries (auth read)
  router.get("/audit", heavyReadLimiter, requirePermission("read:repository"), (req, res) => {
    const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 100;
    const rows = db.prepare(
      "SELECT * FROM explainer_audit_log ORDER BY created_at DESC LIMIT ?",
    ).all(Number.isFinite(limit) ? Math.min(limit, 500) : 100) as any[];
    res.json({ entries: rows, count: rows.length });
  });

  // GET /api/explainer/fleet/health-drift — runbook automation: stale bundles,
  // score regressions, and unpublished knowledge drift in one alertable view.
  router.get("/fleet/health-drift", publicReadLimiter, requirePermission("read:repository"), (_req, res) => {
    const now = Date.now();
    const staleDays = Number(process.env.DJIMITFLO_STALENESS_DAYS) || 15;
    const rows = db.prepare(
      `SELECT COALESCE(dr.full_name, t.remote_url) AS full_name,
              b.id AS bundle_id, b.openmythos_score, b.status, b.created_at
       FROM explainer_bundles b
       JOIN explainer_tasks t ON t.id = b.task_id
       LEFT JOIN discovered_repositories dr ON dr.id = t.discovered_repository_id
       WHERE dr.full_name IS NOT NULL
       ORDER BY dr.full_name, b.created_at DESC`,
    ).all() as any[];
    // Latest published bundle per repo + previous published score for regression detection
    const perRepo = new Map<string, { latest: any; previous_score: number | null }>();
    for (const row of rows) {
      const entry = perRepo.get(row.full_name) ?? { latest: null, previous_score: null };
      if (row.status === "published") {
        if (!entry.latest) entry.latest = row;
        else if (entry.previous_score === null) entry.previous_score = row.openmythos_score;
      }
      perRepo.set(row.full_name, entry);
    }
    const drift: Array<Record<string, unknown>> = [];
    for (const [fullName, entry] of perRepo) {
      if (!entry.latest) {
        drift.push({ repo: fullName, drift_type: "never_published" });
        continue;
      }
      const ageDays = (now - new Date(entry.latest.created_at).getTime()) / 86_400_000;
      if (ageDays > staleDays) {
        drift.push({ repo: fullName, drift_type: "stale", age_days: Math.round(ageDays), bundle_id: entry.latest.bundle_id });
      }
      if (entry.previous_score !== null && entry.latest.openmythos_score !== null && entry.previous_score - entry.latest.openmythos_score >= 15) {
        drift.push({
          repo: fullName,
          drift_type: "score_regression",
          previous_score: entry.previous_score,
          current_score: entry.latest.openmythos_score,
          delta: Math.round((entry.previous_score - entry.latest.openmythos_score) * 10) / 10,
        });
      }
    }
    res.json({ checked_repos: perRepo.size, stale_threshold_days: staleDays, drift, drift_count: drift.length });
  });

  // GET /api/explainer/fleet/calibration-sample — export published bundles with
  // critic dimensions for human eval (MCR-Bench-style calibration of the 85 threshold).
  router.get("/fleet/calibration-sample", publicReadLimiter, requirePermission("read:repository"), (req, res) => {
    const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 10;
    const rows = db.prepare(
      `SELECT b.id AS bundle_id, b.openmythos_score, b.openmythos_rationale, b.created_at,
              COALESCE(dr.full_name, t.remote_url) AS full_name, b.markdown_path
       FROM explainer_bundles b
       JOIN explainer_tasks t ON t.id = b.task_id
       LEFT JOIN discovered_repositories dr ON dr.id = t.discovered_repository_id
       WHERE b.status = 'published' AND dr.full_name IS NOT NULL
       ORDER BY b.created_at DESC LIMIT ?`,
    ).all(Number.isFinite(limit) ? Math.min(limit, 50) : 10) as any[];
    const origin = process.env.DJIMITFLO_PUBLIC_ORIGIN || `http://localhost:${process.env.PORT || 3001}`;
    const sample = rows.map((row) => {
      const dimensions: Record<string, number> = {};
      for (const part of String(row.openmythos_rationale || "").split("; ")) {
        const [name, score] = part.split(": ");
        if (name && score && !Number.isNaN(Number(score))) dimensions[name] = Number(score);
      }
      let pageUrl: string | null = null;
      if (row.full_name?.includes("/")) {
        const [owner, repo] = row.full_name.split("/");
        pageUrl = `${origin}/explore/${owner}/${repo}`;
      }
      return {
        bundle_id: row.bundle_id,
        repo: row.full_name,
        openmythos_score: row.openmythos_score,
        dimensions,
        generated_at: row.created_at,
        review_url: pageUrl,
        review_prompt: "Rate factual accuracy 0-100 against the source repo; flag any ungrounded claim.",
      };
    });
    res.json({ sample, count: sample.length, note: "Human ratings vs OpenMythos threshold 85 — export as CSV for calibration analysis." });
  });

  // POST /api/explainer/fleet/calibration-rate — record a human rating for a
  // published bundle (governance-calibration dataflow; closes the review loop).
  router.post("/fleet/calibration-rate", mutationLimiter, requirePermission("write:governance"), (req, res) => {
    const { bundle_id, rating, factual_acc, clarity, rated_by, notes } = req.body || {};
    if (typeof bundle_id !== "string" || !bundle_id) {
      res.status(400).json({ error: { message: "bundle_id required", code: "VALIDATION_ERROR" } });
      return;
    }
    const rateNum = Number(rating);
    if (!Number.isFinite(rateNum) || rateNum < 0 || rateNum > 100) {
      res.status(400).json({ error: { message: "rating must be 0-100", code: "VALIDATION_ERROR" } });
      return;
    }
    const bundle = db.prepare("SELECT id, openmythos_score FROM explainer_bundles WHERE id = ?").get(bundle_id) as any;
    if (!bundle) {
      res.status(404).json({ error: { message: "Bundle not found", code: "NOT_FOUND" } });
      return;
    }
    const clamp = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
    };
    db.prepare(
      "INSERT INTO calibration_ratings (id, bundle_id, rating, factual_acc, clarity, rated_by, source, notes) VALUES (?, ?, ?, ?, ?, ?, 'dashboard', ?)",
    ).run(
      randomUUID(),
      bundle_id,
      Math.round(rateNum),
      clamp(factual_acc),
      clamp(clarity),
      typeof rated_by === "string" && rated_by ? rated_by.slice(0, 100) : ((req as any).user?.sub ?? "operator"),
      typeof notes === "string" ? notes.slice(0, 500) : null,
    );
    db.prepare(
      "INSERT INTO explainer_audit_log (id, actor, action, resource_type, resource_id, outcome, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      randomUUID(),
      (req as any).user?.sub ?? "operator",
      "calibration_rating",
      "explainer_bundle",
      bundle_id,
      "success",
      `human=${Math.round(rateNum)} vs system=${bundle.openmythos_score ?? "n/a"}`,
      new Date().toISOString(),
    );
    res.json({ bundle_id, rating: Math.round(rateNum), system_score: bundle.openmythos_score ?? null });
  });

  // GET /api/explainer/fleet/calibration-stats — threshold calibration analytics
  router.get("/fleet/calibration-stats", heavyReadLimiter, requirePermission("read:repository"), (_req, res) => {
    const rows = db.prepare(
      `SELECT r.rating AS human, b.openmythos_score AS system
       FROM calibration_ratings r
       JOIN explainer_bundles b ON b.id = r.bundle_id
       WHERE b.openmythos_score IS NOT NULL`,
    ).all() as Array<{ human: number; openmythos_score: number; system?: number }>;
    const pairs = rows.map((r) => ({ human: r.human, system: r.system ?? (r as any).openmythos_score }));
    const n = pairs.length;
    if (n === 0) {
      res.json({ ratings: 0, note: "No calibration ratings yet — record human ratings via POST /fleet/calibration-rate." });
      return;
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const humanScores = pairs.map((p) => p.human);
    const sysScores = pairs.map((p) => p.system);
    const mh = mean(humanScores);
    // Pearson correlation + mean absolute error
    const cov = pairs.reduce((s, p) => s + (p.human - mh) * (p.system - mean(sysScores)), 0);
    const varH = pairs.reduce((s, p) => s + (p.human - mh) ** 2, 0);
    const varS = pairs.reduce((s, p) => s + (p.system - mean(sysScores)) ** 2, 0);
    const corr = varH && varS ? cov / Math.sqrt(varH * varS) : null;
    const mae = mean(pairs.map((p) => Math.abs(p.human - p.system)));
    res.json({
      ratings: n,
      human_mean: Math.round(mh * 10) / 10,
      system_mean: Math.round(mean(sysScores) * 10) / 10,
      mean_abs_error: Math.round(mae * 10) / 10,
      correlation: corr === null ? null : Math.round(corr * 1000) / 1000,
      suggested_threshold: Math.round(Math.min(100, Math.max(0, mh))),
      note: "Threshold calibration: compare human_mean/system_mean and MAE — if MAE < 10 the 85-threshold is well-grounded.",
    });
  });

  // ─── Grounded Q&A over de knowledge pack (ExplainerAskService) ────────────

  const askService = new ExplainerAskService(db, knowledge);

  // Strikte limiter voor ask: LLM-kosten + abuse-surface per IP (20/min)
  const askLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });

  // POST /api/explainer/ask — grounded Q&A met claim-verify, refusal en audit-lineage (FR-015)
  router.post("/ask", askLimiter, requirePermission("read:repository"), async (req, res) => {
    const t0 = Date.now();
    try {
      const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
      if (!question || question.length < 3) {
        res.status(400).json({ error: { message: "question required (min 3 chars)", code: "VALIDATION_ERROR" } });
        return;
      }
      if (question.length > 2000) {
        res.status(400).json({ error: { message: "question too long (max 2000)", code: "VALIDATION_ERROR" } });
        return;
      }
      const repo = typeof req.body?.repo === "string" && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(req.body.repo) ? req.body.repo.slice(0, 200) : undefined;
      const answer = await askService.ask(question, { repo });
      // FR-015 lineage: persist every ask for audit + quality analytics
      try {
        db.prepare(
          "INSERT INTO explainer_audit_log (id, actor, action, resource_type, resource_id, outcome, reason, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          randomUUID(),
          (req as any).user?.sub ?? "anonymous",
          "ask_query",
          "knowledge_pack",
          answer.refused ? "refused" : "answered",
          answer.refused ? "blocked" : "success",
          answer.refusal_reason ? String(answer.refusal_reason).slice(0, 500) : null,
          JSON.stringify({
            question: question.slice(0, 300),
            repo: repo ?? null,
            mode: answer.mode,
            grounding_ratio: answer.grounding_ratio,
            claims_checked: answer.claim_report?.checked ?? 0,
            claims_resolved: answer.claim_report?.resolved ?? 0,
            latency_ms: Date.now() - t0,
          }),
          new Date().toISOString(),
        );
      } catch {
        // audit never breaks the answer path
      }
      res.json(answer);
    } catch (error) {
      res.status(500).json({ error: { message: error instanceof Error ? error.message : String(error), code: "ASK_ERROR" } });
    }
  });

  // ─── Human review resolution (governance loop closure) ────────────────────

  // GET /api/explainer/review-queue — open human review items
  router.get("/review-queue", publicReadLimiter, requirePermission("read:repository"), (_req, res) => {
    const rows = db.prepare(
      "SELECT * FROM human_review_queue WHERE resolved = 0 ORDER BY created_at ASC LIMIT 100",
    ).all() as any[];
    res.json({ items: rows, count: rows.length });
  });

  // POST /api/explainer/review-queue/:id/resolve — approve/reject with reason
  router.post("/review-queue/:id/resolve", mutationLimiter, requirePermission("write:governance"), (req, res) => {
    const id = req.params.id;
    const resolution = req.body?.resolution;
    if (!["approved", "rejected"].includes(resolution)) {
      res.status(400).json({ error: { message: "resolution must be 'approved' or 'rejected'", code: "VALIDATION_ERROR" } });
      return;
    }
    const item = db.prepare("SELECT * FROM human_review_queue WHERE id = ? AND resolved = 0").get(id) as any;
    if (!item) {
      res.status(404).json({ error: { message: "Review item not found or already resolved", code: "NOT_FOUND" } });
      return;
    }
    const now = new Date().toISOString();
    db.prepare("UPDATE human_review_queue SET resolved = 1, resolution = ?, resolved_at = ?, metadata = ? WHERE id = ?").run(
      resolution,
      now,
      JSON.stringify({ reason: typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : null }),
      id,
    );
    // approved → publish the bundle; rejected → unpublish (governance actie)
    if (resolution === "approved") {
      db.prepare("UPDATE explainer_bundles SET status = 'published', updated_at = ? WHERE id = ?").run(now, item.bundle_id);
    } else {
      db.prepare("UPDATE explainer_bundles SET status = 'unpublished', updated_at = ? WHERE id = ?").run(now, item.bundle_id);
    }
    // Governance-calibration dataflow: an optional human rating flows into
    // calibration_ratings so the 85-threshold gets data-driven (closes loop B).
    const ratingNum = Number(req.body?.calibration_rating);
    if (Number.isFinite(ratingNum) && ratingNum >= 0 && ratingNum <= 100) {
      db.prepare(
        "INSERT INTO calibration_ratings (id, bundle_id, rating, rated_by, source, notes) VALUES (?, ?, ?, ?, 'dashboard', ?)",
      ).run(
        randomUUID(),
        item.bundle_id,
        Math.round(ratingNum),
        (req as any).user?.sub ?? "operator",
        `review-resolution: ${resolution}`,
      );
    }
    db.prepare(
      "INSERT INTO explainer_audit_log (id, actor, action, resource_type, resource_id, outcome, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      randomUUID(),
      (req as any).user?.sub ?? "operator",
      `review_${resolution}`,
      "human_review_queue",
      id,
      "success",
      req.body?.reason ? String(req.body.reason).slice(0, 500) : null,
      now,
    );
    res.json({ id, resolution, bundle_id: item.bundle_id, bundle_status: resolution === "approved" ? "published" : "unpublished" });
  });

  return router;
}
