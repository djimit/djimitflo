import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createExplainerRoutes } from "../routes/explainer";
import { fullSchema } from "../database/schema";
import { runMigrations } from "../database/migrate";
import { AuthService } from "../services/auth-service";
import { createAuthMiddleware } from "../middleware/auth";
import express from "express";
import request from "supertest";
import { cleanupRepo, createMinimalRepo } from "./fixtures/synthetic-repos";

describe("Explainer routes", () => {
  let db: Database.Database;
  let auth: any;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(fullSchema);
    runMigrations(db);
    const authService = new AuthService(db);
    authService.bootstrapAdmin();
    auth = createAuthMiddleware(authService);
  });

  afterEach(() => {
    db.close();
  });

  it("creates an explainer router", () => {
    const router = createExplainerRoutes(db, auth);
    expect(router).toBeDefined();
    expect(router.stack.length).toBeGreaterThan(0);
  });

  it("creates, lists and retrieves explainer tasks over HTTP", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/explainer", createExplainerRoutes(db, {
      requirePermission: () => (_req: any, _res: any, next: any) => next(),
    } as any));

    const invalid = await request(app).post("/api/explainer/tasks").send({ title: "missing source" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("VALIDATION_ERROR");

    const created = await request(app).post("/api/explainer/tasks").send({
      title: "DjimFlo explainer",
      description: "route proof",
      provider: "github",
      remote_url: "https://github.com/djimit/djimitflo.git",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: "DjimFlo explainer", status: "pending", remote_url: "https://github.com/djimit/djimitflo.git" });

    const listed = await request(app).get("/api/explainer/tasks");
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ count: 1, tasks: [created.body] });

    const fetched = await request(app).get(`/api/explainer/tasks/${created.body.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(created.body);
    expect((await request(app).get("/api/explainer/tasks/missing")).status).toBe(404);

    const repo = createMinimalRepo();
    try {
      const local = await request(app).post("/api/explainer/tasks").send({
        title: "local pipeline",
        provider: "local",
        local_path: repo.path,
      });
      expect(local.status).toBe(201);
      const run = await request(app).post(`/api/explainer/tasks/${local.body.id}/run`).send({ skipGraph: true, dryRun: true });
      expect(run.status).toBe(200);
      expect(run.body).toMatchObject({ task_id: local.body.id });
      const completed = await request(app).get(`/api/explainer/tasks/${local.body.id}`);
      expect(completed.body.status).toBe("completed");
      const bundles = await request(app).get(`/api/explainer/tasks/${local.body.id}/bundles`);
      expect(bundles.status).toBe(200);
      expect(bundles.body.count).toBe(1);
    } finally {
      cleanupRepo(repo);
    }
  });
});
