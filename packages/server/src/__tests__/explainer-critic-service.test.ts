import { describe, it, expect } from "vitest";
import { join } from "path";
import { ExplainerCriticService } from "../services/explainer-critic-service";
import type { ExplainerBundleContent, ExplainerFact } from "@djimitflo/shared";

const baseBundle = (overrides: Partial<ExplainerBundleContent> = {}): ExplainerBundleContent => ({
  manifest: {
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
  },
  explainer_md: "# juraregel\n\nA Python project by djimit.\n\n## Stack\n\nTypeScript and npm, detected from package.json.\n\n## Entry Point\n\nThe CLI entry point is `src/cli.py`.\n\n## Health\n\nMissing AGENTS.md; recommendation: add AGENTS.md per Djimit conventions.\n\n## Dependencies\n\nDependency audit found no critical vulnerabilities.\n\n## License\n\nLicensed under MIT. See LICENSE file.",
  llms_txt: "juraregel Python CLI by djimit. MIT license.",
  facts: Array.from({ length: 5 }, (_, i) => ({
    id: `fact-${i}`,
    claim: `claim ${i}`,
    source_ref: `src/cli.py:${10 + i}`,
    source_type: "file_line",
    confidence: 0.9,
  })) as ExplainerFact[],
  sections: {
    overview: "overview text",
    architecture: "architecture text",
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
});

describe("ExplainerCriticService", () => {
  it("loads corpus cases", () => {
    const service = new ExplainerCriticService(join(__dirname, "..", "..", "corpus", "explainer.corpus.jsonl"));
    const cases = service.loadCases();
    expect(cases.length).toBeGreaterThan(0);
    expect(cases[0]).toHaveProperty("id");
    expect(cases[0]).toHaveProperty("category");
  });

  it("scores a strong bundle above threshold", () => {
    const service = new ExplainerCriticService(join(__dirname, "..", "..", "corpus", "explainer.corpus.jsonl"));
    const result = service.evaluate(baseBundle());
    expect(result.passed).toBe(true);
    expect(result.overall_score).toBeGreaterThanOrEqual(85);
    expect(result.dimensions.length).toBeGreaterThan(0);
  });

  it("fails a bundle with invented security claims", () => {
    const service = new ExplainerCriticService(join(__dirname, "..", "..", "corpus", "explainer.corpus.jsonl"));
    const result = service.evaluate(baseBundle({
      explainer_md: "This project uses end-to-end encryption and bank-grade security.",
    }));
    expect(result.passed).toBe(false);
    const security = result.dimensions.find((d) => d.name === "security");
    expect(security?.score).toBeLessThan(100);
    expect(security?.findings.length).toBeGreaterThan(0);
  });

  it("penalizes a bundle missing license attribution", () => {
    const service = new ExplainerCriticService(join(__dirname, "..", "..", "corpus", "explainer.corpus.jsonl"));
    const result = service.evaluate(baseBundle({
      explainer_md: "# juraregel\n\nA Python project by djimit.",
      llms_txt: "juraregel Python CLI by djimit.",
    }));
    const license = result.dimensions.find((d) => d.name === "license");
    expect(license?.score).toBeLessThan(100);
    expect(license?.findings.length).toBeGreaterThan(0);
  });

  it("penalizes too few facts", () => {
    const service = new ExplainerCriticService(join(__dirname, "..", "..", "corpus", "explainer.corpus.jsonl"));
    const result = service.evaluate(baseBundle({ facts: baseBundle().facts.slice(0, 2) }));
    const quality = result.dimensions.find((d) => d.name === "quality");
    expect(quality?.findings.some((f) => f.includes("cited facts"))).toBe(true);
  });
});
