import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from "better-sqlite3";
import { createTestDb } from "./helpers/test-db";
import { LlmRouterService } from "../services/llm-router-service";

const databases: Database.Database[] = [];
const db = () => { const d = createTestDb(); databases.push(d); return d; };
afterEach(() => databases.splice(0).forEach(d => d.close()));

describe("LlmRouterService", () => {
  let service: LlmRouterService;
  beforeEach(() => {
    service = new LlmRouterService(db());
    // Activate providers for testing
    for (const provider of ["anthropic", "openai", "google", "ollama", "litellm"] as const) {
      service.recordPerformance({ provider, taskType: "coding", latencyMs: 1000, success: true });
    }
  });

  it("returns a routing decision", () => {
    const d = service.route({ taskType: "coding", prompt: "Write a function" });
    expect(d.provider).toBeDefined();
    expect(d.model).toBeDefined();
    expect(d.estimatedCost).toBeGreaterThanOrEqual(0);
  });

  it("respects cascade hint", () => {
    const d = service.route({ taskType: "coding", prompt: "test" }, { modelId: "litellm", escalationLevel: 2 });
    expect(d.reason).toContain("Cascade");
  });

  it("records performance and updates posterior", () => {
    service.recordPerformance({ provider: "litellm", taskType: "coding", latencyMs: 1000, success: true });
    service.recordPerformance({ provider: "litellm", taskType: "coding", latencyMs: 1200, success: true });
    const s = service.getBanditStats().find(x => x.id === "litellm");
    expect(s).toBeDefined();
    expect(s!.nObservations).toBeGreaterThanOrEqual(2);
  });

  it("getBanditStats returns CI", () => {
    const s = service.getBanditStats().find(x => x.id === "anthropic");
    expect(s!.ci95).toBeDefined();
    expect(s!.ci95[0]).toBeLessThanOrEqual(s!.meanSuccess);
    expect(s!.ci95[1]).toBeGreaterThanOrEqual(s!.meanSuccess);
  });

  it("exploration rate tracked", () => {
    for (let i = 0; i < 10; i++) service.route({ taskType: "coding", prompt: "t" + i });
    expect(service.getStats().explorationRate).toBeGreaterThanOrEqual(0);
  });

  it("getStats returns provider counts", () => {
    const stats = service.getStats();
    expect(stats.totalProviders).toBe(5);
    expect(stats.activeProviders).toBeGreaterThanOrEqual(1);
  });

  it("returns finite stats before any observations", () => {
    const fresh = new LlmRouterService(db());
    const stats = fresh.getBanditStats();
    expect(stats.every(s => Number.isFinite(s.meanSuccess) && s.ci95.every(Number.isFinite))).toBe(true);
    expect(stats.every(s => s.ci95[0] === 0 && s.ci95[1] === 1)).toBe(true);
  });
});
