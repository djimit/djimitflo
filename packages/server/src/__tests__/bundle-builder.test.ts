import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createTestDb } from "./helpers/test-db";
import { BundleBuilder } from "../services/bundle-builder";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { GraphSummary, ExplainerFact } from "@djimitflo/shared";

const graphSummary: GraphSummary = {
  total_nodes: 10,
  total_edges: 12,
  total_files: 5,
  risk_score: null,
  communities: [{ name: "Core", size: 5, cohesion: 0.8, language: "typescript" }],
  top_flows: [],
  hub_nodes: [],
  bridge_nodes: [],
};

const facts: ExplainerFact[] = [
  { id: "f1", claim: "Entry point is src/index.ts", source_ref: "src/index.ts:1", source_type: "file_line", confidence: 0.9 },
];

function makeInput(bundleRoot: string) {
  return {
    taskId: "task-1",
    repositoryFullName: "djimit/test-repo",
    repositoryUrl: "https://github.com/djimit/test-repo",
    sourceCommit: "abc123",
    bundleRoot,
    graphSummary,
    scanSummary: {},
    sections: {
      overview: "Test repo overview.",
      architecture: "Architecture summary.",
      health: "Health score 85.",
      dependencies: "npm based.",
    },
    facts,
    openmythosScore: 88,
  };
}

describe("BundleBuilder", () => {
  let db: Database.Database;
  let builder: BundleBuilder;
  let bundleRoot: string;

  beforeEach(() => {
    db = createTestDb();
    db.prepare("INSERT INTO explainer_tasks (id, title, description) VALUES (?, ?, ?)").run("task-1", "Test task", "Description");
    builder = new BundleBuilder(db);
    bundleRoot = mkdtempSync(join(tmpdir(), "bundle-builder-"));
  });

  afterEach(() => {
    rmSync(bundleRoot, { recursive: true, force: true });
  });

  it("emits bundle files and persists metadata", () => {
    const result = builder.build(makeInput(bundleRoot));

    expect(existsSync(result.bundlePath)).toBe(true);
    expect(existsSync(result.manifestPath)).toBe(true);
    expect(existsSync(result.markdownPath)).toBe(true);
    expect(existsSync(result.llmsTxtPath)).toBe(true);
    expect(existsSync(result.factsPath)).toBe(true);
    expect(existsSync(result.sectionsPath)).toBe(true);
    expect(existsSync(result.assetsPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf-8"));
    expect(manifest.repository_full_name).toBe("djimit/test-repo");
    expect(manifest.openmythos_score).toBe(88);
    expect(manifest.assets).toEqual([]);

    const row = db.prepare("SELECT * FROM explainer_bundles WHERE id = ?").get(result.bundleId) as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.status).toBe("pending");
    expect(row.content_hash).toBe(result.contentHash);
  });

  it("loads bundle content from database", () => {
    const result = builder.build(makeInput(bundleRoot));
    const content = builder.loadBundleContent(result.bundleId);

    expect(content.manifest.bundle_id).toBe(result.bundleId);
    expect(content.sections.overview).toBe("Test repo overview.");
    expect(content.facts.length).toBe(1);
  });

  it("throws for invalid repository full name", () => {
    const input = makeInput(bundleRoot);
    input.repositoryFullName = "invalid";
    expect(() => builder.build(input)).toThrow("Invalid repository_full_name");
  });

  it("keeps same-commit bundles immutable", () => {
    const first = builder.build(makeInput(bundleRoot));
    const firstManifest = readFileSync(first.manifestPath, "utf-8");
    const second = builder.build(makeInput(bundleRoot));

    expect(second.bundlePath).not.toBe(first.bundlePath);
    expect(readFileSync(first.manifestPath, "utf-8")).toBe(firstManifest);
  });
});
