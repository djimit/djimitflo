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
});
