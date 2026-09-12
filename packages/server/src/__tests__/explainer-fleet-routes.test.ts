import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import express from "express";
import { createTestDb } from "./helpers/test-db";
import { createExplainerRoutes } from "../routes/explainer";
import { RepoExplainerScheduler } from "../services/repo-explainer-scheduler";

function buildApp(db: Database.Database) {
  const app = express();
  const auth = {
    requireAuth: (_req: any, _res: any, next: any) => next(),
    requirePermission: (_perm: string) => (_req: any, _res: any, next: any) => next(),
    optionalAuth: (_req: any, _res: any, next: any) => next(),
    requireAuthOrSpawnToken: (_req: any, _res: any, next: any) => next(),
  };
  app.use("/api/explainer", createExplainerRoutes(db, auth as any));
  return app;
}

function request(app: express.Express, method: string, path: string, body?: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req: any = {
      method,
      url: path,
      path,
      headers: { "content-type": "application/json" },
      body: body ?? {},
      ip: "127.0.0.1",
      connection: { remoteAddress: "127.0.0.1" },
    };
    const res: any = { statusCode: 200, headers: {} };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (payload: any) => { res.body = payload; resolve({ status: res.statusCode, body: payload }); return res; };
    res.send = (payload: any) => { res.body = payload; resolve({ status: res.statusCode, body: payload }); return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
    res.get = (_k: string) => undefined;
    res.set = res.setHeader;
    res.append = (k: string, v: string) => { res.headers[k] = v; return res; };
    app(req as any, res as any, (err: any) => (err ? reject(err) : undefined));
  });
}

describe("Explainer fleet routes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("GET /fleet/status returns scheduler status and repo counts", async () => {
    const app = buildApp(db);
    db.prepare(`
      INSERT INTO discovered_repositories (id, owner, name, full_name, priority_tier, html_url, clone_url, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("repo-1", "djimit", "a", "djimit/a", 1, "https://github.com/djimit/a", "https://github.com/djimit/a.git", 1);

    const result = await request(app, "GET", "/api/explainer/fleet/status");

    expect(result.status).toBe(200);
    expect(result.body.total_repositories).toBe(1);
    expect(result.body.active_repositories).toBe(1);
    expect(typeof result.body.budget.llm_calls_remaining).toBe("number");
  });

  it("POST /fleet/sync returns a DiscoverySyncResult", async () => {
    const app = buildApp(db);
    const result = await request(app, "POST", "/api/explainer/fleet/sync", { owner: "djimit" });

    expect(result.status).toBe(200);
    expect(result.body.owner).toBe("djimit");
    expect(typeof result.body.discovered).toBe("number");
  });

  it("POST /fleet/refresh-stale returns scheduled jobs", async () => {
    const app = buildApp(db);
    db.prepare(`
      INSERT INTO discovered_repositories (id, owner, name, full_name, priority_tier, html_url, clone_url, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("repo-1", "djimit", "a", "djimit/a", 1, "https://github.com/djimit/a", "https://github.com/djimit/a.git", 1);

    const result = await request(app, "POST", "/api/explainer/fleet/refresh-stale", { owner: "djimit" });

    expect(result.status).toBe(200);
    expect(result.body.scheduled).toBe(1);
  });

  it("POST /fleet/pause and /fleet/resume toggle paused state", async () => {
    const app = buildApp(db);

    const pauseResult = await request(app, "POST", "/api/explainer/fleet/pause");
    expect(pauseResult.body.paused).toBe(true);

    const resumeResult = await request(app, "POST", "/api/explainer/fleet/resume");
    expect(resumeResult.body.paused).toBe(false);
  });

  it("kill switch atomically cancels queued work, blocks claims/manual starts, and reports in-flight work", async () => {
    const app = buildApp(db);
    for (const [id, status] of [
      ["kill-pending", "pending"],
      ["kill-queued", "pending"],
      ["kill-running", "running"],
      ["kill-manual", "pending"],
    ]) {
      db.prepare("INSERT INTO explainer_tasks (id, title, provider, status) VALUES (?, ?, 'local', ?)").run(id, id, status);
    }
    const insertJob = db.prepare("INSERT INTO explainer_jobs (id, task_id, status) VALUES (?, ?, ?)");
    insertJob.run("job-kill-pending", "kill-pending", "pending");
    insertJob.run("job-kill-queued", "kill-queued", "queued");
    insertJob.run("job-kill-running", "kill-running", "running");

    const result = await request(app, "POST", "/api/explainer/fleet/kill-switch", { reason: "route fixture" });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      paused: true,
      pending_cancelled: true,
      cancelled_job_count: 2,
      cancelled_task_count: 2,
      in_flight_work_uninterrupted: 1,
    });
    expect(db.prepare("SELECT status FROM explainer_jobs WHERE id = 'job-kill-pending'").get()).toEqual({ status: "cancelled" });
    expect(db.prepare("SELECT status FROM explainer_jobs WHERE id = 'job-kill-queued'").get()).toEqual({ status: "cancelled" });
    expect(db.prepare("SELECT status FROM explainer_jobs WHERE id = 'job-kill-running'").get()).toEqual({ status: "running" });
    expect(db.prepare("SELECT status FROM explainer_tasks WHERE id = 'kill-pending'").get()).toEqual({ status: "cancelled" });
    expect(db.prepare("SELECT status FROM explainer_tasks WHERE id = 'kill-queued'").get()).toEqual({ status: "cancelled" });
    expect(db.prepare("SELECT status FROM explainer_tasks WHERE id = 'kill-running'").get()).toEqual({ status: "running" });
    expect(new RepoExplainerScheduler(db).isPaused()).toBe(true);
    expect(db.prepare("SELECT reason FROM explainer_audit_log WHERE action = 'fleet_kill_switch'").get()).toEqual({ reason: "route fixture" });

    const claim = new RepoExplainerScheduler(db).claimNextJob("worker-after-kill");
    expect(claim).toBeNull();
    const manualRun = await request(app, "POST", "/api/explainer/tasks/kill-manual/run");
    expect(manualRun.status).toBe(409);
    expect(manualRun.body.error.code).toBe("FLEET_PAUSED");
    expect(db.prepare("SELECT status FROM explainer_tasks WHERE id = 'kill-manual'").get()).toEqual({ status: "pending" });
    expect(db.prepare("SELECT outcome, reason FROM explainer_audit_log WHERE resource_id = 'kill-manual' AND action = 'pipeline_run'").get())
      .toEqual({ outcome: "blocked", reason: "Fleet paused" });

    new RepoExplainerScheduler(db).setPaused(false);
    db.prepare("UPDATE explainer_tasks SET status = 'running' WHERE id = 'kill-manual'").run();
    const duplicateRun = await request(app, "POST", "/api/explainer/tasks/kill-manual/run");
    expect(duplicateRun.status).toBe(409);
    expect(duplicateRun.body.error.code).toBe("TASK_ALREADY_RUNNING");
    expect(db.prepare("SELECT COUNT(*) AS count FROM explainer_audit_log WHERE resource_id = 'kill-manual' AND action = 'pipeline_run' AND outcome = 'blocked'").get()).toEqual({ count: 2 });
  });

  it("blocks fleet regeneration while paused and retains an audited cancelled task", async () => {
    const app = buildApp(db);
    db.prepare(`
      INSERT INTO discovered_repositories (id, owner, name, full_name, priority_tier, html_url, clone_url, is_active)
      VALUES ('repo-paused', 'fixture', 'repo', 'fixture/repo', 1, 'https://github.com/fixture/repo', 'https://github.com/fixture/repo.git', 1)
    `).run();
    new RepoExplainerScheduler(db).setPaused(true);

    const result = await request(app, "POST", "/api/explainer/fleet/regenerate", { full_name: "fixture/repo" });

    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("FLEET_PAUSED");
    expect(db.prepare("SELECT status FROM explainer_tasks").get()).toEqual({ status: "cancelled" });
    expect(db.prepare("SELECT outcome, reason FROM explainer_audit_log WHERE action = 'pipeline_run'").get())
      .toEqual({ outcome: "blocked", reason: "Fleet paused" });
  });

  it("GET /fleet/repos lists discovered repositories", async () => {
    const app = buildApp(db);
    db.prepare(`
      INSERT INTO discovered_repositories (id, owner, name, full_name, priority_tier, html_url, clone_url, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("repo-1", "djimit", "a", "djimit/a", 1, "https://github.com/djimit/a", "https://github.com/djimit/a.git", 1);

    const result = await request(app, "GET", "/api/explainer/fleet/repos");

    expect(result.status).toBe(200);
    expect(result.body.repositories).toHaveLength(1);
  });

  it("POST /fleet/run schedules one scheduler iteration", async () => {
    const app = buildApp(db);
    db.prepare(`
      INSERT INTO discovered_repositories (id, owner, name, full_name, priority_tier, html_url, clone_url, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("repo-1", "djimit", "a", "djimit/a", 1, "https://github.com/djimit/a", "https://github.com/djimit/a.git", 1);

    const result = await request(app, "POST", "/api/explainer/fleet/run");

    expect(result.status).toBe(200);
    expect(result.body.scheduled).toBe(1);
  });
});
