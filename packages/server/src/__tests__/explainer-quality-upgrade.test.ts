import { describe, it, expect } from "vitest";
import { ExplainerMermaidService } from "../services/explainer-mermaid-service";
import { ExplainerClaimVerifier } from "../services/explainer-claim-verifier";
import type { ExplainerFact, GraphSummary } from "@djimitflo/shared";

describe("ExplainerMermaidService", () => {
  const svc = new ExplainerMermaidService();

  it("validates a correct flowchart", () => {
    const src = 'flowchart LR\n  C0["Core"]\n  C1["Services"]\n  C0 -.-> C1';
    expect(svc.validate(src)).toBe(true);
  });

  it("rejects unbalanced brackets", () => {
    expect(svc.validate('flowchart LR\n  C0["Unclosed'))
      .toBe(false);
    expect(svc.validate("flowchart LR\n  C0[label]]")).toBe(false);
  });

  it("rejects unknown diagram types", () => {
    expect(svc.validate("notadiagram\n  X")).toBe(false);
  });

  it("repairs a line with unbalanced label or skips it", () => {
    const bad = 'flowchart LR\n  C0["ok"]\n  C1[broken\n  C2["also ok"]';
    const repaired = svc.repair(bad);
    expect(repaired).not.toBeNull();
    expect(repaired).not.toContain("[broken");
  });

  it("generates a valid architecture diagram from graph summary", () => {
    const graph: GraphSummary = {
      total_nodes: 10,
      total_edges: 8,
      total_files: 12,
      risk_score: null,
      communities: [
        { name: "Core", size: 2, cohesion: 0.8, language: "typescript" },
        { name: "Services", size: 3, cohesion: 0.7, language: "typescript" },
      ],
      top_flows: [],
      hub_nodes: [{ name: "App.tsx", file: "src/App.tsx", total_degree: 5 }],
      bridge_nodes: [],
    };
    const diagram = svc.generateArchitectureDiagram(graph);
    expect(diagram).not.toBeNull();
    expect(diagram!.valid).toBe(true);
    expect(diagram!.source).toContain("flowchart");
  });
});

describe("ExplainerClaimVerifier", () => {
  const verifier = new ExplainerClaimVerifier();

  const facts: ExplainerFact[] = [
    { id: "fact-1", claim: "uses npm", source_ref: "scan:dependency_manifest", source_type: "scan_finding", confidence: 0.9 },
    { id: "fact-2", claim: "hub node", source_ref: "graph:hub:App.tsx", source_type: "graph_node", confidence: 0.85, file_path: "src/App.tsx" },
  ];

  it("resolves fact-id citations present in facts", () => {
    const report = verifier.verify({ overview: "Stack uses npm [fact-1]." }, facts);
    expect(report.grounding_ratio).toBe(1);
    expect(report.unresolved).toHaveLength(0);
  });

  it("flags fact-id citations that do not exist", () => {
    const report = verifier.verify({ overview: "Claim [fact-9] is bogus." }, facts);
    expect(report.unresolved).toHaveLength(1);
    expect(report.grounding_ratio).toBe(0);
  });

  it("resolves graph node citations", () => {
    const report = verifier.verify({ architecture: "See [graph:hub:App.tsx] for complexity." }, facts);
    expect(report.grounding_ratio).toBe(1);
  });

  it("is neutral when no citations exist", () => {
    const report = verifier.verify({ overview: "plain text" }, facts);
    expect(report.checked).toBe(0);
    expect(report.grounding_ratio).toBe(1);
  });
});