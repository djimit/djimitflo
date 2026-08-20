import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import express from "express";
import { createTestDb } from "./helpers/test-db";
import { createExplainerRoutes } from "../routes/explainer";

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
