import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ExplainerPreflightService,
  type PreflightReport,
} from "../services/explainer-preflight-service";
import type {
  ExplainerBundleContent,
  ExplainerCriticResult,
  ExplainerManifest,
} from "@djimitflo/shared";

function makeManifest(overrides: Partial<ExplainerManifest> = {}): ExplainerManifest {
  return {
    schema_version: "1.0.0",
    bundle_id: "bundle-1",
    task_id: "task-1",
    repository_full_name: "djimit/juraregel",
    repository_url: "https://github.com/djimit/juraregel",
    source_commit: "abc123",
    pipeline_version: "0.1.0",
    generated_at: new Date().toISOString(),
    openmythos_score: null,
    content_hash: "sha256-deadbeef",
    sections: [],
    assets: [],
    ...overrides,
  };
}

function makeBundle(
  dir: string,
  overrides: Partial<ExplainerBundleContent> = {},
): ExplainerBundleContent {
  const manifestPath = join(dir, "manifest.json");
  const mdPath = join(dir, "explainer.md");
  const llmsPath = join(dir, "llms.txt");

  const manifest = makeManifest();
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(mdPath, "# juraregel\n\nA project by djimit. Licensed under MIT.");
  writeFileSync(llmsPath, "juraregel by djimit. MIT license.");

  return {
    manifest,
    explainer_md: mdPath,
    llms_txt: llmsPath,
    facts: Array.from({ length: 5 }, (_, i) => ({
      id: `fact-${i}`,
      claim: `claim ${i}`,
      source_ref: `src/cli.py:${10 + i}`,
      source_type: "file_line",
      confidence: 0.9,
    })),
    sections: {
      overview: "overview text",
      architecture: "architecture text with aria-describedby summary",
      health: "health text",
    },
    metadata: {
      task_id: "task-1",
      repository_url: "https://github.com/djimit/juraregel",
      local_path: null,
      generated_at: new Date().toISOString(),
    },
    graph_summary: {
      total_nodes: 10,
      total_edges: 12,
      total_files: 5,
      risk_score: null,
      communities: [],
      top_flows: [],
      hub_nodes: [],
      bridge_nodes: [],
    },
    openmythos_scores: null,
    ...overrides,
  };
}

function makeCritic(score: number): ExplainerCriticResult {
  return {
    overall_score: score,
    threshold: 85,
    passed: score >= 85,
    dimensions: [],
    retry_hints: [],
    latency_ms: 0,
  };
}

describe("ExplainerPreflightService", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "explainer-preflight-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("approves a complete bundle with a passing critic score", () => {
    const service = new ExplainerPreflightService();
    const bundle = makeBundle(dir);
    const result = service.check(bundle, makeCritic(92), []);
    expect(result.passed).toBe(true);
    expect(result.blocking_checks).toEqual([]);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it("blocks a bundle with a low OpenMythos score", () => {
    const service = new ExplainerPreflightService();
    const bundle = makeBundle(dir);
    const result = service.check(bundle, makeCritic(70), []);
    expect(result.passed).toBe(false);
    expect(result.blocking_checks).toContain("openmythos_score");
  });

  it("blocks a bundle when secret findings exist", () => {
    const service = new ExplainerPreflightService();
    const bundle = makeBundle(dir);
    const result = service.check(bundle, makeCritic(92), ["api-key in .env"]);
    expect(result.passed).toBe(false);
    expect(result.blocking_checks).toContain("secret_scan_clean");
  });

  it("blocks a bundle with too few cited facts", () => {
    const service = new ExplainerPreflightService();
    const bundle = makeBundle(dir, {
      facts: [{ id: "f1", claim: "x", source_ref: "", source_type: "file_line", confidence: 0.5 }],
    });
    const result = service.check(bundle, makeCritic(92), []);
    expect(result.passed).toBe(false);
    expect(result.blocking_checks).toContain("fact_citations_verified");
  });

  it("blocks a bundle missing license attribution", () => {
    const service = new ExplainerPreflightService();
    const mdPath = join(dir, "no-license.md");
    const llmsPath = join(dir, "no-license.txt");
    writeFileSync(mdPath, "# project\n\nDescription only.");
    writeFileSync(llmsPath, "Description only.");
    const bundle = makeBundle(dir, { explainer_md: mdPath, llms_txt: llmsPath });
    const result = service.check(bundle, makeCritic(92), []);
    expect(result.passed).toBe(false);
    expect(result.blocking_checks).toContain("license_footer_present");
  });

  it("blocks a bundle with architecture content but no accessibility labels", () => {
    const service = new ExplainerPreflightService();
    const bundle = makeBundle(dir, {
      sections: { architecture: "architecture without aria labels" },
    });
    const result = service.check(bundle, makeCritic(92), []);
    expect(result.passed).toBe(false);
    expect(result.blocking_checks).toContain("accessibility_labels_present");
  });

  it("blocks a bundle when bundle files are missing", () => {
    const service = new ExplainerPreflightService();
    const bundle = makeBundle(dir, { explainer_md: "/does/not/exist.md" });
    const result = service.check(bundle, makeCritic(92), []);
    expect(result.passed).toBe(false);
    expect(result.blocking_checks).toContain("bundle_files_exist");
  });
});
