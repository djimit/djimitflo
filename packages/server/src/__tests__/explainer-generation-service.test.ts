import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ExplainerGenerationService } from "../services/explainer-generation-service";
import { ExplainerStatus } from "@djimitflo/shared";
import { createTestDb } from "./helpers/test-db";

describe("ExplainerGenerationService", () => {
  let db: Database.Database;
  let service: ExplainerGenerationService;
  let tempRepo: string;

  beforeEach(() => {
    db = createTestDb();
    service = new ExplainerGenerationService(db, mkdtempSync(join(tmpdir(), "explainer-")));
    tempRepo = mkdtempSync(join(tmpdir(), "repo-"));
    writeFileSync(join(tempRepo, "README.md"), ["# Test Repo", "", "This is a sample project."].join("\n"));
    mkdirSync(join(tempRepo, "src"));
    writeFileSync(join(tempRepo, "src", "index.ts"), "export const hello = () => 'world';\n");
    writeFileSync(join(tempRepo, "package.json"), JSON.stringify({ name: "test-repo", scripts: { test: "vitest" } }));
  });

  afterEach(() => {
    db.close();
    rmSync(tempRepo, { recursive: true, force: true });
  });

  it("creates a task with local path", async () => {
    const task = await service.createTask({ title: "Test", local_path: tempRepo });
    expect(task.title).toBe("Test");
    expect(task.status).toBe(ExplainerStatus.PENDING);
    expect(task.local_path).toBe(tempRepo);
  });

  it("requires remote_url or local_path", async () => {
    await expect(service.createTask({ title: "Test" })).rejects.toThrow("Either remote_url or local_path is required");
  });

  it("ingests a local repository", async () => {
    const task = await service.createTask({ title: "Test", local_path: tempRepo });
    const ingest = await service.ingestRepository(task);
    expect(ingest.localPath).toBe(tempRepo);
    expect(ingest.repositoryUrl).toBeNull();
  });

  it("scans a local repository", async () => {
    const task = await service.createTask({ title: "Test", local_path: tempRepo });
    const ingest = await service.ingestRepository(task);
    const scan = await service.scanRepository(ingest.localPath);
    expect(scan.stack.detectedStacks).toContain("node");
    expect(scan.stack.testCommands.length).toBeGreaterThanOrEqual(0);
  });

  it("generates a bundle", async () => {
    const task = await service.createTask({ title: "Test", local_path: tempRepo, remote_url: "https://github.com/djimit/test-repo" });
    const ingest = await service.ingestRepository(task);
    const scan = await service.scanRepository(ingest.localPath);
    const graph = await service.buildGraph(scan.repository?.id || "repo-1", ingest.localPath, scan.scanId || null, scan.gitStatus?.headCommit || null);
    const { bundleId, content } = await service.generateBundle(task, ingest, scan, graph);
    expect(content.explainer_md).toContain("djimit/test-repo");
    expect(content.llms_txt).toContain("# djimit/test-repo");
    expect(content.metadata.task_id).toBe(task.id);
    expect(bundleId).toBeDefined();
  });

  it("evaluates a bundle", async () => {
    const bundle: any = {
      explainer_md: ["## Stack", "Detected stacks: node", "## Limitations", "This project has 5 routes and uses Djimitflo."].join(String.fromCharCode(10)),
      llms_txt: "test",
      metadata: { task_id: "x", repository_url: null, local_path: "/tmp", generated_at: new Date().toISOString() },
      graph_summary: { total_nodes: 0, total_edges: 0, total_files: 0, risk_score: null, communities: [], top_flows: [], hub_nodes: [], bridge_nodes: [] },
      openmythos_scores: null,
    };
    const scores = service.evaluateBundle(bundle);
    expect(scores.hallucination).toBeGreaterThan(0.5);
    expect(scores.tool_scope).toBeGreaterThan(0.5);
    expect(scores.overthinking).toBeGreaterThan(0.5);
  });

  it("writes an evidence bundle", async () => {
    const task = await service.createTask({ title: "Test", local_path: tempRepo, remote_url: "https://github.com/djimit/test-repo" });
    const ingest = await service.ingestRepository(task);
    const scan = await service.scanRepository(ingest.localPath);
    const graph = await service.buildGraph(scan.repository?.id || "repo-1", ingest.localPath, scan.scanId || null, scan.gitStatus?.headCommit || null);
    const { bundleId, content } = await service.generateBundle(task, ingest, scan, graph);
    const bundlePath = await service.writeEvidenceBundle(task.id, content);
    expect(bundlePath).toContain("explainer");
    const rows = db.prepare("SELECT * FROM explainer_bundles WHERE task_id = ?").all(task.id) as any[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows.find((r) => r.id === bundleId);
    expect(row).toBeDefined();
  });
});
