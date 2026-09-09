import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTestDb } from "./helpers/test-db";
import { createExplorePublicRoutes } from "../routes/explore-public";
import { ExplorePublicPageService } from "../services/explore-public-page-service";
import { BundleBuilder } from "../services/bundle-builder";

const servers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function bundle(overview: string) {
  return {
    manifest: {
      repository_full_name: "djimit/repo-one",
      repository_url: "https://github.com/djimit/repo-one",
      source_commit: "abcdef123",
      generated_at: "2026-08-20T00:00:00Z",
      openmythos_score: 90,
    },
    sections: { overview },
    facts: [],
    graph_summary: { communities: [] },
    llms_txt: "# repo-one",
  } as any;
}

describe("public explore boundary", () => {
  // contract:explore-public:GET:/:owner/:repo
  it("rejects hostile route parameters as plain text with security headers", async () => {
    const previousOrigin = process.env.DJIMITFLO_PUBLIC_ORIGIN;
    process.env.DJIMITFLO_PUBLIC_ORIGIN = "https://explore.djimit.nl";
    const app = express().use("/explore", createExplorePublicRoutes(createTestDb()));
    if (previousOrigin === undefined) delete process.env.DJIMITFLO_PUBLIC_ORIGIN;
    else process.env.DJIMITFLO_PUBLIC_ORIGIN = previousOrigin;
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test listener");

    const response = await fetch(`http://127.0.0.1:${address.port}/explore/djimit/%3Cscript%3Ealert(1)%3C%2Fscript%3E`);
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(body).not.toContain("<script>");
  });

  it("drops unsafe generated links and keeps normal HTTPS links", () => {
    const service = new ExplorePublicPageService(createTestDb());
    const result = service.render({
      owner: "djimit",
      repo: "repo-one",
      baseUrl: "https://explore.djimit.nl",
      bundleContent: bundle("# Repo\n\n[unsafe](javascript:evil) [source](https://example.com/docs)"),
    });

    expect(result.html).not.toContain('href="javascript:');
    expect(result.html).toContain("https://example.com/docs");
    expect(result.html).not.toContain("cdn.tailwindcss.com");
    expect(result.html).toContain('rel="canonical" href="https://explore.djimit.nl/explore/djimit/repo-one"');
  });

  it("looks up published bundles by exact repository identity", () => {
    const db = createTestDb();
    db.prepare(`
      INSERT INTO discovered_repositories (id, owner, name, full_name, html_url, clone_url)
      VALUES ('repo-1', 'djimit', 'repo-one', 'djimit/repo-one', 'https://github.com/djimit/repo-one', 'https://github.com/djimit/repo-one.git')
    `).run();
    db.prepare(`
      INSERT INTO explainer_tasks (id, title, description, provider, remote_url, discovered_repository_id, status)
      VALUES ('task-1', 'Explain repo-one', '', 'github', 'https://github.com/djimit/repo-one', 'repo-1', 'completed')
    `).run();
    const bundleRoot = mkdtempSync(join(tmpdir(), "explore-public-"));
    tempDirs.push(bundleRoot);
    const result = new BundleBuilder(db).build({
      taskId: "task-1",
      repositoryFullName: "djimit/repo-one",
      repositoryUrl: "https://github.com/djimit/repo-one",
      sourceCommit: "abcdef123",
      bundleRoot,
      graphSummary: { total_nodes: 0, total_edges: 0, total_files: 0, risk_score: null, communities: [], top_flows: [], hub_nodes: [], bridge_nodes: [] },
      scanSummary: {},
      sections: { overview: "# repo-one" },
      facts: [],
      openmythosScore: 90,
    });
    db.prepare("UPDATE explainer_bundles SET status = 'published' WHERE id = ?").run(result.bundleId);
    const service = new ExplorePublicPageService(db);

    expect(service.findPublishedBundle("djimit", "repo-one")?.manifest.bundle_id).toBe(result.bundleId);
    expect(service.findPublishedBundle("%", "repo-one")).toBeNull();
  });

  // contract:explore-public:GET:/:owner/:repo/llms.txt
  // contract:explore-public:GET:/:owner/:repo/opengraph.svg
  it("serves the public knowledge pack and OpenGraph card", async () => {
    const db = createTestDb();
    db.prepare(`
      INSERT INTO discovered_repositories (id, owner, name, full_name, html_url, clone_url)
      VALUES ('repo-1', 'djimit', 'repo-one', 'djimit/repo-one', 'https://github.com/djimit/repo-one', 'https://github.com/djimit/repo-one.git')
    `).run();
    db.prepare(`
      INSERT INTO explainer_tasks (id, title, description, provider, remote_url, discovered_repository_id, status)
      VALUES ('task-1', 'Explain repo-one', '', 'github', 'https://github.com/djimit/repo-one', 'repo-1', 'completed')
    `).run();
    const bundleRoot = mkdtempSync(join(tmpdir(), "explore-public-routes-"));
    tempDirs.push(bundleRoot);
    const built = new BundleBuilder(db).build({
      taskId: "task-1",
      repositoryFullName: "djimit/repo-one",
      repositoryUrl: "https://github.com/djimit/repo-one",
      sourceCommit: "abcdef123",
      bundleRoot,
      graphSummary: { total_nodes: 0, total_edges: 0, total_files: 0, risk_score: null, communities: [], top_flows: [], hub_nodes: [], bridge_nodes: [] },
      scanSummary: {},
      sections: { overview: "# repo-one" },
      facts: [],
      openmythosScore: 90,
    });
    db.prepare("UPDATE explainer_bundles SET status = 'published' WHERE id = ?").run(built.bundleId);
    const app = express().use("/explore", createExplorePublicRoutes(db));
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test listener");
    const origin = `http://127.0.0.1:${address.port}`;

    const llms = await fetch(`${origin}/explore/djimit/repo-one/llms.txt`);
    const card = await fetch(`${origin}/explore/djimit/repo-one/opengraph.svg`);
    expect(llms.status).toBe(200);
    expect(await llms.text()).toContain("repo-one");
    expect(card.status).toBe(200);
    expect(card.headers.get("content-type")).toContain("image/svg+xml");
    expect(await card.text()).toContain("DJIMIT EXPLORE");
  });

  // contract:explore-public:GET:/leaderboard
  describe("public governance leaderboard", () => {
    function startApp(env: Record<string, string> = {}, db?: ReturnType<typeof createTestDb>) {
      const previous: Record<string, string | undefined> = {};
      const envWithOrigin = { DJIMITFLO_PUBLIC_ORIGIN: "https://explore.djimit.nl", ...env };
      for (const [key, value] of Object.entries(envWithOrigin)) {
        previous[key] = process.env[key];
        process.env[key] = value;
      }
      const app = express().use("/explore", createExplorePublicRoutes(db ?? createTestDb()));
      const server = createServer(app);
      servers.push(server);
      return new Promise<{ url: string; restore: () => void }>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("missing test listener");
          resolve({
            url: `http://127.0.0.1:${address.port}`,
            restore: () => {
              for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
              }
            },
          });
        });
      });
    }

    it("is off by default (404 without OPENMYTHOS_LEADERBOARD_PUBLIC)", async () => {
      // Kilo P2: explicitly clear the gate so the test establishes the true
      // "unset" condition regardless of the host environment, and restore.
      const { url, restore } = await startApp({ OPENMYTHOS_LEADERBOARD_PUBLIC: "" });
      const response = await fetch(`${url}/explore/leaderboard`);
      expect(response.status).toBe(404);
      expect(await response.text()).toContain("not published");
      restore();
    });

    it("returns 404 when explicitly disabled", async () => {
      const { url, restore } = await startApp({ OPENMYTHOS_LEADERBOARD_PUBLIC: "false" });
      const response = await fetch(`${url}/explore/leaderboard`);
      expect(response.status).toBe(404);
      restore();
    });

    it("serves model-only scores sorted best-first with no case content", async () => {
      const db = createTestDb();
      const corpus = "71ca62e742f71c2830f198c01dbcacdcf75487b9ef96e661d3e297d6608d41b9";
      const caseIds = Array.from({ length: 78 }, (_, i) => `case-${i}`);
      // two eligible model-only runs + one eligible-but-older pair for trend
      const insert = (id: string, agent: string, score: number, finishedAt: string) =>
        db.prepare(`
          INSERT INTO openmythos_eval_runs (id, agent_id, started_at, finished_at, total_cases, completed_cases, overall_score, status, metadata)
          VALUES (?, ?, ?, ?, 78, 78, ?, 'completed', ?)
        `).run(id, agent, finishedAt, finishedAt, score, JSON.stringify({
          evaluation_mode: "model_only",
          oracle_anchors_configured: 1,
          case_ids: caseIds,
          corpus_sha256: corpus,
        }));

      insert("run-1", "nightly:qwen2.5-coder:3b", 2.69, "2026-09-07T03:10:00Z");
      insert("run-2", "nightly:llama3.2:1b", 1.92, "2026-09-07T03:15:00Z");
      insert("run-3", "nightly:qwen2.5:3b", 2.33, "2026-09-07T03:20:00Z");
      // excluded: explainer-critic (0-100 scale) and a skill-conditioned run
      insert("run-4", "explainer-critic", 87, "2026-09-07T03:25:00Z");
      insert("run-5", "skill-conditioned", 4.8, "2026-09-07T03:30:00Z");

      const { url, restore } = await startApp({ OPENMYTHOS_LEADERBOARD_PUBLIC: "true" }, db);
      const response = await fetch(`${url}/explore/leaderboard`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      const payload = await response.json();

      expect(payload.leaderboard.map((r: any) => r.agent_id)).toEqual([
        "nightly:qwen2.5-coder:3b",
        "nightly:qwen2.5:3b",
        "nightly:llama3.2:1b",
      ]);
      const keys = new Set(payload.leaderboard.flatMap((r: any) => Object.keys(r)));
      expect(keys.has("prompt")).toBe(false);
      expect(keys.has("case_content")).toBe(false);
      expect(payload.leaderboard[0].overall_score).toBe(2.69);
      expect(payload.leaderboard[0].total_cases).toBe(78);
      restore();
    });

    it("filters malformed metadata rows instead of crashing", async () => {
      const db = createTestDb();
      db.prepare(`
        INSERT INTO openmythos_eval_runs (id, agent_id, started_at, finished_at, total_cases, completed_cases, overall_score, status, metadata)
        VALUES ('run-bad', 'nightly:broken', '2026-09-07T03:00:00Z', '2026-09-07T03:00:00Z', 78, 78, 3.0, 'completed', '{malformed json')
      `).run();
      const { url, restore } = await startApp({ OPENMYTHOS_LEADERBOARD_PUBLIC: "true" });
      const response = await fetch(`${url}/explore/leaderboard`);
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload.leaderboard).toEqual([]);
      restore();
    });

    it("pins the snapshot to a single corpus revision", async () => {
      const db = createTestDb();
      const caseIds = Array.from({ length: 78 }, (_, i) => `case-${i}`);
      const insert = (id: string, agent: string, score: number, corpus: string, finishedAt: string) =>
        db.prepare(`
          INSERT INTO openmythos_eval_runs (id, agent_id, started_at, finished_at, total_cases, completed_cases, overall_score, status, metadata)
          VALUES (?, ?, ?, ?, 78, 78, ?, 'completed', ?)
        `).run(id, agent, finishedAt, finishedAt, score, JSON.stringify({
          evaluation_mode: "model_only",
          oracle_anchors_configured: 1,
          case_ids: caseIds,
          corpus_sha256: corpus,
        }));

      // nieuwste run = corpus-B; agent op corpus-A moet niet meedoen
      insert("run-newest", "nightly:new-model", 4.0, "corpus-B", "2026-09-07T04:00:00Z");
      insert("run-old", "nightly:old-model", 3.0, "corpus-A", "2026-09-07T01:00:00Z");

      const { url, restore } = await startApp({ OPENMYTHOS_LEADERBOARD_PUBLIC: "true" }, db);
      const payload = await (await fetch(`${url}/explore/leaderboard`)).json();
      expect(payload.leaderboard.map((r: any) => r.agent_id)).toEqual(["nightly:new-model"]);
      restore();
    });

    it("excludes subset evaluations (case_ids != completed_cases)", async () => {
      const db = createTestDb();
      db.prepare(`
        INSERT INTO openmythos_eval_runs (id, agent_id, started_at, finished_at, total_cases, completed_cases, overall_score, status, metadata)
        VALUES ('run-subset', 'nightly:subset', '2026-09-07T03:00:00Z', '2026-09-07T03:00:00Z', 78, 1, 5.0, 'completed', ?)
      `).run(JSON.stringify({
        evaluation_mode: "model_only",
        oracle_anchors_configured: 1,
        case_ids: ["case-1"],
        corpus_sha256: "71ca62e742f71c2830f198c01dbcacdcf75487b9ef96e661d3e297d6608d41b9",
      }));
      const { url, restore } = await startApp({ OPENMYTHOS_LEADERBOARD_PUBLIC: "true" }, db);
      const payload = await (await fetch(`${url}/explore/leaderboard`)).json();
      expect(payload.leaderboard).toEqual([]);
      restore();
    });
  });
});
