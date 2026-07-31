import { describe, it, expect } from "vitest";
import { createTestDb } from "./helpers/test-db";
import { ExplainerDiscoveryService } from "../services/explainer-discovery-service";

describe("debug deactivate", () => {
  it("logs", async () => {
    const db = createTestDb();
    const calls: string[] = [];
    const fetcher = async (url: string): Promise<Response> => {
      calls.push(url);
      const type = new URL(url).pathname.split("/")[1];
      if (type !== "orgs") {
        return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) } as Response;
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => [{ id: 1, name: "repo-one", full_name: "djimit/repo-one", owner: { login: "djimit" }, default_branch: "main", fork: false, archived: false, html_url: "https://github.com/djimit/repo-one", clone_url: "https://github.com/djimit/repo-one.git", language: "TypeScript", license: { spdx_id: "MIT" }, stargazers_count: 12, open_issues_count: 3, pushed_at: "2026-07-30T12:00:00Z", updated_at: "2026-07-30T12:00:00Z" }],
      } as Response;
    };

    const service = new ExplainerDiscoveryService(db, { fetcher });
    const r1 = await service.syncDiscoveredRepositories("djimit");
    console.log("r1", r1, "calls", calls);
    const rows1 = service.listDiscoveredRepositories("djimit");
    console.log("rows1", rows1.map((r) => r.full_name));

    calls.length = 0;
    const fetcher2 = async (url: string): Promise<Response> => {
      calls.push(url);
      const type = new URL(url).pathname.split("/")[1];
      if (type !== "orgs") {
        return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) } as Response;
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => [{ id: 2, name: "repo-two", full_name: "djimit/repo-two", owner: { login: "djimit" }, default_branch: "main", fork: false, archived: false, html_url: "https://github.com/djimit/repo-two", clone_url: "https://github.com/djimit/repo-two.git", language: "Python", license: null, stargazers_count: 1, open_issues_count: 0, pushed_at: "2026-07-30T12:00:00Z", updated_at: "2026-07-30T12:00:00Z" }],
      } as Response;
    };

    const service2 = new ExplainerDiscoveryService(db, { fetcher: fetcher2 });
    const r2 = await service2.syncDiscoveredRepositories("djimit");
    console.log("r2", r2, "calls", calls);
    const rows2 = service2.listDiscoveredRepositories("djimit");
    console.log("rows2", rows2.map((r) => ({ full_name: r.full_name, is_active: r.is_active })));

    expect(r2.deactivated).toBe(1);
  });
});
