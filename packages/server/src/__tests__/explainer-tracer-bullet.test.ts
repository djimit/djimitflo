import { afterEach, describe, it, expect, beforeEach } from "vitest";
import { resolve } from "path";
import Database from "better-sqlite3";
import { createTestDb } from "./helpers/test-db";
import { ExplainerGenerationService } from "../services/explainer-generation-service";

describe("Explainer tracer bullet on djimitflo", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    delete process.env.DJIMITFLO_REPOSITORY_ROOTS;
    db.close();
  });

  it("runs the full pipeline on the djimitflo working copy", async () => {
    const repositoryPath = resolve(process.cwd(), "../..");
    process.env.DJIMITFLO_REPOSITORY_ROOTS = repositoryPath;
    const service = new ExplainerGenerationService(db, { cacheRoot: undefined });
    const task = await service.createTask({
      title: "djimitflo tracer bullet",
      local_path: repositoryPath,
      remote_url: "https://github.com/djimit/djimitflo",
    });

    const bundleId = await service.runPipeline(task.id);
    expect(bundleId).toBeDefined();

    const taskRow = db.prepare("SELECT * FROM explainer_tasks WHERE id = ?").get(task.id) as Record<string, unknown>;
    expect(taskRow.status).toBe("completed");

    const bundle = db.prepare("SELECT * FROM explainer_bundles WHERE id = ?").get(bundleId) as Record<string, unknown>;
    expect(bundle).toBeDefined();
    expect(bundle.openmythos_score).not.toBeNull();
    expect(typeof bundle.openmythos_score).toBe("number");
  }, 120_000);
});
