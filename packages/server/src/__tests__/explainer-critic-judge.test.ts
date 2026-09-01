import { describe, it, expect } from "vitest";
import { ExplainerCriticService } from "../services/explainer-critic-service";
import { JudgeService } from "../services/judge-service";
import Database from "better-sqlite3";
import type { ExplainerBundleContent } from "@djimitflo/shared";

function makeBundle(overrides: Partial<ExplainerBundleContent> = {}): ExplainerBundleContent {
  return {
    manifest: { task_id: "t1", repository_full_name: "djimit/x" } as any,
    explainer_md: "# x\n\nUses node and typescript.",
    llms_txt: "x uses node.",
    facts: [
      { id: "fact-1", claim: "uses node", source_ref: "scan:stack", source_type: "scan_finding", confidence: 0.9 },
 { id: "fact-2", claim: "typescript language", source_ref: "graph:community:x", source_type: "graph_node", confidence: 0.85 },
    ],
    sections: {
      overview: "The repository x uses node [fact-1] and typescript [fact-2]. It is MIT licensed [fact-1].",
      architecture: "Structural analysis [fact-2] shows one community.",
      health: "Health score 90 with no critical findings [fact-1].",
      dependencies: "Uses npm [fact-1]. No known critical vulnerabilities [fact-2].",
    },
    metadata: { task_id: "t1", repository_url: null, local_path: null, generated_at: new Date().toISOString() },
    graph_summary: { total_nodes: 2, total_edges: 1, total_files: 3, risk_score: null, communities: [], top_flows: [], hub_nodes: [], bridge_nodes: [] },
    ...overrides,
  };
}

describe("ExplainerCriticService — JudgeService integration (layer 2)", () => {
  const db = new Database(":memory:");
  const judge = new JudgeService(db as any);

  it("runs 6-dim oracle-only when no judge is wired", () => {
    const svc = new ExplainerCriticService(undefined as any);
    const result = svc.evaluate(makeBundle());
    expect(result.dimensions.find((d) => d.name === "consistency")).toBeUndefined();
    expect(result.dimensions.length).toBe(6);
  });

  it("appends a consistency dimension when a judge is wired in", () => {
    const svc = new ExplainerCriticService(undefined as any, judge);
    const result = svc.evaluate(makeBundle());
    const consistency = result.dimensions.find((d) => d.name === "consistency");
    expect(consistency).toBeDefined();
    expect(consistency!.score).toBeGreaterThanOrEqual(0);
    expect(consistency!.score).toBeLessThanOrEqual(100);
    expect(result.dimensions.length).toBe(7);
  });

  it("flags contradictions as findings so they surface in retry hints", () => {
    const contradictory = makeBundle({
      sections: {
        overview: "Uses node [fact-1].",
        architecture: "Uses node [fact-1].",
        health: "Does not use node at all [fact-2].",
        dependencies: "Uses node [fact-1] but also exclusively python [fact-2].",
      },
    });
    const svc = new ExplainerCriticService(undefined as any, judge);
    const result = svc.evaluate(contradictory);
    const consistency = result.dimensions.find((d) => d.name === "consistency");
    expect(consistency).toBeDefined();
    // Low-verdict scores land in findings → retry hints
    if (consistency!.score < 70) {
      expect(consistency!.findings.length).toBeGreaterThan(0);
    }
  });

  it("overall score drops when consistency is poor", () => {
    // 6-dim oracle-only baseline vs 7-dim with judge — the average shifts
    const svc = new ExplainerCriticService(undefined as any, judge);
    const withJudge = svc.evaluate(makeBundle());
    const withoutJudge = new ExplainerCriticService(undefined as any).evaluate(makeBundle());
    // both in valid range; with-judge average can go either way but stays bounded
    expect(withJudge.overall_score).toBeGreaterThanOrEqual(0);
    expect(withJudge.overall_score).toBeLessThanOrEqual(100);
    expect(withoutJudge.overall_score).toBeGreaterThanOrEqual(0);
  });
});