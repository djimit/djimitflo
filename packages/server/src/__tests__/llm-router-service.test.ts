import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    const d = service.route({ taskType: "coding", prompt: "test" }, { modelId: "ollama", escalationLevel: 2 });
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

const KEY_ENVS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "LITELLM_API_KEY"];
const TASK_TYPES = ["embedding", "creative", "chat", "coding", "analysis", "reasoning"] as const;
const stubHealth = (status: number) => vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status })));

describe("LlmRouterService eligibility (INT-001/INT-002)", () => {
  beforeEach(() => { for (const key of KEY_ENVS) vi.stubEnv(key, undefined); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("does not sample a provider degraded by a 503 health refresh; recovery to 200 restores it without inventing an outcome", async () => {
    const service = new LlmRouterService(db());
    service.recordPerformance({ provider: "ollama", taskType: "coding", latencyMs: 100, success: true });
    stubHealth(503);
    await service.refreshProviderHealth();
    expect(service.getProviderHealth().find(p => p.name === "ollama")!.available).toBe(false);
    expect(service.route({ taskType: "coding", prompt: "p" })).toMatchObject({ available: false });

    stubHealth(200);
    await service.refreshProviderHealth();
    expect(service.route({ taskType: "coding", prompt: "p" })).toMatchObject({ available: true, provider: "ollama" });
    expect(service.getBanditStats().find(s => s.id === "ollama")!.nObservations).toBe(1);
  });

  it("keeps a provider without its API key ineligible even after a success report and a 200 health check", async () => {
    const service = new LlmRouterService(db());
    service.recordPerformance({ provider: "litellm", taskType: "embedding", latencyMs: 100, success: true });
    stubHealth(200);
    await service.refreshProviderHealth();
    expect(service.route({ taskType: "embedding", prompt: "p" })).toMatchObject({ available: false });

    vi.stubEnv("LITELLM_API_KEY", "test-key");
    await service.refreshProviderHealth();
    expect(service.route({ taskType: "embedding", prompt: "p" })).toMatchObject({ available: true, provider: "litellm" });
  });

  it("never recommends a model that lacks the declared task capability", () => {
    const service = new LlmRouterService(db());
    service.recordPerformance({ provider: "ollama", taskType: "coding", latencyMs: 100, success: true });
    // ollama is the only healthy, credential-free arm, but it declares no embedding capability.
    expect(service.route({ taskType: "embedding", prompt: "p" })).toMatchObject({ available: false });
  });

  it("only returns decisions from the eligible capability set for every task type", async () => {
    for (const key of KEY_ENVS) vi.stubEnv(key, "test-key");
    const service = new LlmRouterService(db());
    for (const provider of ["anthropic", "openai", "google", "ollama", "litellm"] as const) {
      service.recordPerformance({ provider, taskType: "coding", latencyMs: 100, success: true });
    }
    stubHealth(200);
    await service.refreshProviderHealth();
    const capabilities = new Map(service.getProviderHealth().map(p => [p.name, p.capabilities]));
    for (const taskType of TASK_TYPES) {
      const decisions = Array.from({ length: 30 }, () => service.route({ taskType, prompt: "p" }) as { available?: boolean; provider?: string });
      const incapable = decisions.map(d => d.provider).filter(p => !capabilities.get(p as never)?.includes(taskType));
      expect(incapable, taskType).toEqual([]);
      expect(decisions.every(d => d.available === true), taskType).toBe(true);
    }
  });
});

describe("LlmRouterService posterior scope (INT-003)", () => {
  it("labels the learned posterior session-only: it resets on restart while request metrics persist", () => {
    const shared = db();
    const first = new LlmRouterService(shared);
    first.recordPerformance({ provider: "ollama", taskType: "coding", latencyMs: 100, success: true });
    expect(first.getBanditStats().find(s => s.id === "ollama")!.nObservations).toBe(1);

    const restarted = new LlmRouterService(shared);
    expect(restarted.getStats().totalRequests).toBe(1);
    expect(restarted.getBanditStats().find(s => s.id === "ollama")!.nObservations).toBe(0);
    expect(restarted.getStats().posteriorScope).toBe("session-only");
    expect(restarted.getBanditStats().every(s => s.posteriorScope === "session-only")).toBe(true);
  });
});
