import { describe, it, expect } from "vitest";
import { ExplainerAskService } from "../services/explainer-ask-service";
import type { ExplainerChunk } from "../services/explainer-knowledge-service";

function makeChunk(overrides: Partial<ExplainerChunk> = {}): ExplainerChunk {
  return {
    id: "b1:fact:fact-1",
    repo_full_name: "djimit/test-repo",
    chunk_type: "fact",
    section: null,
    file_path: null,
    line_start: null,
    line_end: null,
    symbol: null,
    text: "The repository uses node and typescript.",
    citation: "scan:dependency_manifest",
    bundle_version: "b1",
    valid_until: new Date(Date.now() + 7 * 86400000).toISOString(),
    ...overrides,
  };
}

const dbStub = {} as any;

function makeAskService(searchResults: Array<{ chunk: ExplainerChunk; score: number; source: "qdrant" | "file_bundle" }>, degraded = false) {
  const knowledge = {
    search: async () => ({ results: searchResults, degraded }),
  } as any;
  return new ExplainerAskService(dbStub, knowledge);
}

describe("ExplainerAskService — refusal paths", () => {
  it("refuses when no evidence matches (NOT_ENOUGH_EVIDENCE)", async () => {
    const svc = makeAskService([]);
    const r = await svc.ask("what is quantum computing", {});
    expect(r.refused).toBe(true);
    expect(r.refusal_reason).toContain("NOT_ENOUGH_EVIDENCE");
    expect(r.answer).toBeNull();
    expect(r.citations).toHaveLength(0);
  });

  it("refuses when best evidence score below minimum", async () => {
    const svc = makeAskService([{ chunk: makeChunk(), score: 0.1, source: "qdrant" }]);
    const r = await svc.ask("unrelated question", {});
    expect(r.refused).toBe(true);
    expect(r.refusal_reason).toContain("NOT_ENOUGH_EVIDENCE");
  });

  it("filters expired knowledge (valid_until in past)", async () => {
    const expired = makeChunk({ valid_until: new Date(Date.now() - 86400000).toISOString() });
    const svc = makeAskService([{ chunk: expired, score: 0.9, source: "qdrant" }]);
    const r = await svc.ask("what stack", {});
    expect(r.refused).toBe(true);
    expect(r.refusal_reason).toContain("geen frisse kennis");
  });
});

describe("ExplainerAskService — citation verification", () => {
  it("verifyCitationMarkers accepts valid markers", () => {
    const svc = new (ExplainerAskService as any)({}, {});
    const report = (svc as any).verifyCitationMarkers("Stack is node [E1] and npm [E2].", 2);
    expect(report.checked).toBe(2);
    expect(report.resolved).toBe(2);
    expect(report.grounding_ratio).toBe(1);
  });

  it("flags fabricated citation markers", () => {
    const svc = new (ExplainerAskService as any)({}, {});
    const report = (svc as any).verifyCitationMarkers("Claims [E1] and [E5] facts.", 2);
    expect(report.checked).toBe(2);
    expect(report.resolved).toBe(1);
    expect(report.unresolved).toHaveLength(1);
    expect(report.unresolved[0].claim).toBe("[E5]");
    expect(report.grounding_ratio).toBeCloseTo(0.5);
  });

  it("treats unmarked text as fully grounded (injected marker path handles it)", () => {
    const svc = new (ExplainerAskService as any)({}, {});
    const report = (svc as any).verifyCitationMarkers("no citations at all", 3);
    expect(report.checked).toBe(0);
    expect(report.grounding_ratio).toBe(1);
  });

  it("injectCitationMarkers refuses unmarked answers (no fabricated grounding)", () => {
    const svc = new (ExplainerAskService as any)({}, {});
    const out = (svc as any).injectCitationMarkers("plain answer without citations");
    expect(out).toBeNull();
    const kept = (svc as any).injectCitationMarkers("answer [E2]");
    expect(kept).toBe("answer [E2]");
  });
});