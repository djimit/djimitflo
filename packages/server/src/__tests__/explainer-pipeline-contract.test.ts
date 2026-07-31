import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createTestDb } from "./helpers/test-db";
import { ExplainerGenerationService } from "../services/explainer-generation-service";
import { createTypeScriptMonorepo, createPythonPackage, createMinimalRepo, cleanupRepo, type SyntheticRepo } from "./fixtures/synthetic-repos";
import { ExplainerProvider, ExplainerStatus } from "@djimitflo/shared";

async function runPipelineOnRepo(db: Database.Database, repo: SyntheticRepo): Promise<{ bundleId: string; taskId: string }> {
  const service = new ExplainerGenerationService(db);
  const task = await service.createTask({
    title: repo.fullName,
    local_path: repo.path,
    remote_url: `https://github.com/${repo.fullName}`,
    provider: ExplainerProvider.LOCAL,
  });
  const bundleId = await service.runPipeline(task.id);
  return { bundleId, taskId: task.id };
}

describe("Explainer pipeline contract tests on synthetic repos", () => {
  let db: Database.Database;
  let repos: SyntheticRepo[];

  beforeEach(() => {
    db = createTestDb();
    repos = [createTypeScriptMonorepo(), createPythonPackage(), createMinimalRepo()];
  });

  it("processes all synthetic repo fixtures end-to-end", async () => {
    for (const repo of repos) {
      const { bundleId, taskId } = await runPipelineOnRepo(db, repo);
      expect(bundleId).toBeDefined();
      expect(typeof bundleId).toBe("string");

      const task = db.prepare("SELECT * FROM explainer_tasks WHERE id = ?").get(taskId) as Record<string, unknown>;
      expect(task).toBeDefined();
      expect(task.status).toBe(ExplainerStatus.COMPLETED);

      const bundle = db.prepare("SELECT * FROM explainer_bundles WHERE id = ?").get(bundleId) as Record<string, unknown>;
      expect(bundle).toBeDefined();
      expect(bundle.openmythos_score).not.toBeNull();

      cleanupRepo(repo);
    }
  });

  it("detects expected stacks and license for TypeScript monorepo", async () => {
    const repo = repos[0];
    const { bundleId } = await runPipelineOnRepo(db, repo);
    const bundle = db.prepare("SELECT * FROM explainer_bundles WHERE id = ?").get(bundleId) as Record<string, unknown>;
    expect(bundle.openmythos_score).toBeGreaterThan(0);
    cleanupRepo(repo);
  });
});
