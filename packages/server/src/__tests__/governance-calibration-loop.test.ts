import { describe, it, expect, beforeEach, afterAll } from "vitest";
import express, { type Express } from "express";
import Database from "better-sqlite3";
import { createTestDb } from "./helpers/test-db";
import { AuthService } from "../services/auth-service";
import { createAuthMiddleware } from "../middleware/auth";
import { createExplainerRoutes } from "../routes/explainer";

/**
 * Governance-calibration loop (B3): human ratings → calibration_ratings →
 * threshold analytics. Uses a real HTTP listener + fetch to keep the test
 * honest end-to-end (auth header → requirePermission → SQLite writes).
 */
describe("governance calibration loop", () => {
  let db: any;
  let authService: any;
  let token: string;
  let server: any;
  let baseUrl: string;
  const bundleId = "cal-bundle-1";

  beforeEach(async () => {
    process.env.JWT_SECRET = "test-secret-32-chars-long-ok1";
    process.env.JWT_EXPIRES_IN = "1h";
    db = createTestDb();
    authService = new AuthService(db as any);
    const auth = createAuthMiddleware(authService);
    const app: Express = express();
    app.use(express.json());
    // Same mount contract as routes/index.ts: requireAuth runs BEFORE the router,
    // so requirePermission sees req.user on every explainer route.
    app.use("/api/explainer", auth.requireAuth, createExplainerRoutes(db, auth));

    authService.createUser("cal@test.local", "password", "admin", "default");
    db.prepare(
      "INSERT INTO explainer_tasks (id, title, provider, status, created_at, updated_at) VALUES ('t1', 'T', 'github', 'completed', datetime('now'), datetime('now'))"
    ).run();
    db.prepare(
      "INSERT INTO explainer_bundles (id, task_id, bundle_path, status, openmythos_score, created_at, updated_at) VALUES (?, 't1', '/tmp/x', 'published', 90, datetime('now'), datetime('now'))"
    ).run(bundleId);

    const user = authService.findUserByEmail("cal@test.local");
    token = authService.generateToken(user);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.JWT_SECRET;
    delete process.env.JWT_EXPIRES_IN;
  });

  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${baseUrl}/api/explainer${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  it("records a calibration rating via direct endpoint and aggregates stats", async () => {
    const res = await call("POST", "/fleet/calibration-rate", { bundle_id: bundleId, rating: 92, factual_acc: 95 });
    expect(res.status).toBe(200);
    expect(res.body.rating).toBe(92);

    const stored = db.prepare("SELECT rating, factual_acc, source FROM calibration_ratings WHERE bundle_id = ?").get(bundleId) as any;
    expect(stored.rating).toBe(92);
    expect(stored.factual_acc).toBe(95);
    expect(stored.source).toBe("dashboard");

    const stats = await call("GET", "/fleet/calibration-stats");
    expect(stats.body.ratings).toBe(1);
    expect(stats.body.human_mean).toBe(92);
    expect(stats.body.suggested_threshold).toBe(92);
  });

  it("flows a calibration rating through review-queue resolution", async () => {
    db.prepare(
      "INSERT INTO human_review_queue (id, bundle_id, reason, created_at) VALUES ('r1', ?, 'test', datetime('now'))"
    ).run(bundleId);

    const res = await call("POST", "/review-queue/r1/resolve", { resolution: "approved", calibration_rating: 88 });
    expect(res.status).toBe(200);

    const stored = db.prepare("SELECT rating, notes FROM calibration_ratings WHERE bundle_id = ?").get(bundleId) as any;
    expect(stored.rating).toBe(88);
    expect(stored.notes).toContain("review-resolution");
  });

  it("rejects invalid calibration ratings (out of 0-100 range)", async () => {
    const res = await call("POST", "/fleet/calibration-rate", { bundle_id: bundleId, rating: 150 });
    expect(res.status).toBe(400);
  });
});