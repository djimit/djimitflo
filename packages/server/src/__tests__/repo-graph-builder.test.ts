import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createTestDb } from "./helpers/test-db";
import { RepoGraphBuilder } from "../services/repo-graph-builder";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function seedRepo(db: Database.Database, ownerRepo: string) {
  const insert = db.prepare(
    "INSERT INTO repositories (id, name, description, path, status, detected_stacks, package_manager) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run("repo-1", ownerRepo, "Test repo", "/tmp", "active", "[]", "npm");
}

function createFakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "repo-graph-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), "export function main() { return 1; }");
  writeFileSync(join(dir, "src", "helper.ts"), "export function helper() { return 2; }");
  writeFileSync(join(dir, "tests", "index.test.ts"), "import { main } from '../src/index';");
  return dir;
}

describe("RepoGraphBuilder", () => {
  let db: Database.Database;
  let builder: RepoGraphBuilder;

  beforeEach(() => {
    db = createTestDb();
    seedRepo(db, "djimit/test-repo");
    builder = new RepoGraphBuilder(db);
  });

  it("builds and persists a synthetic graph snapshot", async () => {
    const repoPath = createFakeRepo();
    const snapshot = await builder.buildGraph(repoPath, {
      repositoryId: "repo-1",
      commitSha: "abc123",
    });

    expect(snapshot.repository_id).toBe("repo-1");
    expect(snapshot.commit_sha).toBe("abc123");
    expect(snapshot.communities.length).toBeGreaterThan(0);
    expect(snapshot.hub_nodes.length).toBeGreaterThan(0);
    expect(snapshot.metrics.total_files).toBeGreaterThanOrEqual(3);

    rmSync(repoPath, { recursive: true, force: true });
  });

  it("retrieves the latest snapshot", async () => {
    const repoPath = createFakeRepo();
    await builder.buildGraph(repoPath, { repositoryId: "repo-1" });
    await builder.buildGraph(repoPath, { repositoryId: "repo-1" });

    const latest = builder.getLatestSnapshot("repo-1");
    expect(latest).toBeDefined();
    expect(latest?.repository_id).toBe("repo-1");

    rmSync(repoPath, { recursive: true, force: true });
  });

  it("returns undefined when no snapshot exists", () => {
    const latest = builder.getLatestSnapshot("repo-missing");
    expect(latest).toBeUndefined();
  });
});
