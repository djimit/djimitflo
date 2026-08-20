import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers/test-db";
import { ExplainerFleetWorker } from "../services/explainer-fleet-worker";
import { RepoExplainerScheduler } from "../services/repo-explainer-scheduler";
import { BundleBuilder } from "../services/bundle-builder";
import { ExplorePublicPageService } from "../services/explore-public-page-service";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("ExplainerFleetWorker", () => {
  it("consumes a scheduled task through the generation service", async () => {
    const db = createTestDb();
    db.prepare(`
      INSERT INTO discovered_repositories (id, owner, name, full_name, html_url, clone_url)
      VALUES ('repo-1', 'djimit', 'repo-one', 'djimit/repo-one', 'https://github.com/djimit/repo-one', 'https://github.com/djimit/repo-one.git')
    `).run();
    const scheduler = new RepoExplainerScheduler(db);
    await scheduler.run();
    const executed: string[] = [];
    const bundleRoot = mkdtempSync(join(tmpdir(), "explainer-worker-"));
    const generation = { runPipeline: async (taskId: string) => {
      executed.push(taskId);
      const built = new BundleBuilder(db).build({
        taskId,
        repositoryFullName: "djimit/repo-one",
        repositoryUrl: "https://github.com/djimit/repo-one",
        sourceCommit: "abcdef123",
        bundleRoot,
        graphSummary: { total_nodes: 0, total_edges: 0, total_files: 0, risk_score: null, communities: [], top_flows: [], hub_nodes: [], bridge_nodes: [] },
        scanSummary: {},
        sections: { overview: "# repo-one" },
        facts: [],
        openmythosScore: 90,
      });
      db.prepare("UPDATE explainer_bundles SET status = 'published' WHERE id = ?").run(built.bundleId);
      return built.bundleId;
    } };
    const worker = new ExplainerFleetWorker(scheduler, generation as any, 60_000);

    try {
      expect(await worker.tick()).toBe(true);
      expect(executed).toHaveLength(1);
      expect(db.prepare("SELECT status FROM explainer_jobs").get()).toMatchObject({ status: "completed" });
      expect(db.prepare("SELECT status FROM explainer_tasks").get()).toMatchObject({ status: "completed" });
      expect(new ExplorePublicPageService(db).findPublishedBundle("djimit", "repo-one")).not.toBeNull();
    } finally {
      rmSync(bundleRoot, { recursive: true, force: true });
    }
  });
});
