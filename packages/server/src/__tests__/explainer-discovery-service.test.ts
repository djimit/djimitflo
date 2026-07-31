import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createTestDb } from "./helpers/test-db";
import { ExplainerDiscoveryService, type GitHubRepo } from "../services/explainer-discovery-service";

function buildRepo(overrides: Partial<GitHubRepo> = {}): GitHubRepo {
  const name = overrides.name ?? "repo-one";
  return {
    id: 1,
    name,
    full_name: `djimit/${name}`,
    owner: { login: "djimit" },
    default_branch: "main",
    fork: false,
    archived: false,
    html_url: `https://github.com/djimit/${name}`,
    clone_url: `https://github.com/djimit/${name}.git`,
    language: "TypeScript",
    license: { spdx_id: "MIT" },
    stargazers_count: 12,
    open_issues_count: 3,
    pushed_at: "2026-07-30T12:00:00Z",
    updated_at: "2026-07-30T12:00:00Z",
    ...overrides,
  };
}

describe("ExplainerDiscoveryService", () => {
  let db: Database.Database;
  let service: ExplainerDiscoveryService;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("syncs non-fork, non-archived repositories into discovered_repositories", async () => {
    const repos = [
      buildRepo({ id: 1, name: "repo-one", full_name: "djimit/repo-one", language: "TypeScript", stargazers_count: 12 }),
      buildRepo({ id: 2, name: "repo-two", full_name: "djimit/repo-two", language: "Python", stargazers_count: 5 }),
      buildRepo({ id: 3, name: "repo-fork", full_name: "djimit/repo-fork", fork: true }),
      buildRepo({ id: 4, name: "repo-old", full_name: "djimit/repo-old", archived: true }),
    ];

    const fetcher = async (_url: string): Promise<Response> => {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => repos,
      } as Response;
    };

    service = new ExplainerDiscoveryService(db, { fetcher });
    const result = await service.syncDiscoveredRepositories("djimit");

    expect(result.discovered).toBe(2);
    expect(result.active).toBe(2);
    expect(result.deactivated).toBe(0);

    const rows = service.listDiscoveredRepositories("djimit");
    expect(rows).toHaveLength(2);
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(["repo-one", "repo-two"]);
  });

  it("updates existing repositories and preserves ids", async () => {
    const repo = buildRepo({ id: 1, name: "repo-one", stargazers_count: 5 });
    const fetcher = async (_url: string): Promise<Response> => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => [repo],
    } as Response);

    service = new ExplainerDiscoveryService(db, { fetcher });
    await service.syncDiscoveredRepositories("djimit");

    const before = service.getDiscoveredRepository("djimit/repo-one")!;

    const updatedRepo = buildRepo({ id: 1, name: "repo-one", stargazers_count: 55 });
    const fetcher2 = async (_url: string): Promise<Response> => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => [updatedRepo],
    } as Response);

    service = new ExplainerDiscoveryService(db, { fetcher: fetcher2 });
    await service.syncDiscoveredRepositories("djimit");

    const after = service.getDiscoveredRepository("djimit/repo-one")!;
    expect(after.id).toBe(before.id);
    expect(after.stargazers_count).toBe(55);
    expect(after.priority_tier).toBe(1);
  });

  it("deactivates repositories no longer returned by the API", async () => {
    const fetcher = async (url: string): Promise<Response> => {
      const type = new URL(url).pathname.split("/")[1];
      if (type !== "orgs") {
        return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) } as Response;
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => [buildRepo({ id: 1, name: "repo-one" })],
      } as Response;
    };

    service = new ExplainerDiscoveryService(db, { fetcher });
    await service.syncDiscoveredRepositories("djimit");

    const fetcher2 = async (url: string): Promise<Response> => {
      const type = new URL(url).pathname.split("/")[1];
      if (type !== "orgs") {
        return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) } as Response;
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => [buildRepo({ id: 2, name: "repo-two" })],
      } as Response;
    };

    service = new ExplainerDiscoveryService(db, { fetcher: fetcher2 });
    const result = await service.syncDiscoveredRepositories("djimit");

    expect(result.deactivated).toBe(1);
    const old = service.getDiscoveredRepository("djimit/repo-one");
    expect(old?.is_active).toBe(0);
  });

  it("handles rate limiting gracefully without deactivating existing entries", async () => {
    const fetcher = async (_url: string): Promise<Response> => ({
      ok: false,
      status: 403,
      headers: new Headers({ "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60) }),
      json: async () => ({}),
    } as Response);

    service = new ExplainerDiscoveryService(db, { fetcher });
    const result = await service.syncDiscoveredRepositories("djimit");

    expect(result.discovered).toBe(0);
    expect(result.errors.some((e) => e.includes("RATE_LIMITED"))).toBe(true);
  });

  it("paginates through multiple pages of results", async () => {
    let page = 0;
    const fetcher = async (url: string): Promise<Response> => {
      const type = new URL(url).pathname.split("/")[1];
      if (type !== "orgs") {
        return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) } as Response;
      }
      const pageParam = new URL(url).searchParams.get("page") || "1";
      page = Number(pageParam);
      if (page > 2) {
        return { ok: true, status: 200, headers: new Headers(), json: async () => [] } as Response;
      }
      const repo = buildRepo({ id: page, name: `repo-${page}`, full_name: `djimit/repo-${page}` });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => [repo],
      } as Response;
    };

    service = new ExplainerDiscoveryService(db, { fetcher, pageSize: 1 });
    const result = await service.syncDiscoveredRepositories("djimit");

    expect(result.discovered).toBe(2);
    expect(page).toBe(3);
  });
});
