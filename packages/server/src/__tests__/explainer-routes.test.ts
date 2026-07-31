import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createExplainerRoutes } from "../routes/explainer";
import { schema } from "../database/schema";
import { runMigrations } from "../database/migrate";
import { AuthService } from "../services/auth-service";
import { createAuthMiddleware } from "../middleware/auth";

describe("Explainer routes", () => {
  let db: Database.Database;
  let auth: any;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(schema);
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
});
