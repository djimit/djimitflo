import { afterEach, describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createTestDb } from "./helpers/test-db";
import { RepositoryScanner } from "../services/repository-scanner";
import { mkdtempSync, realpathSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function createFakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "repo-scanner-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "test-repo",
    license: "MIT",
    dependencies: { express: "^4.18.0" },
    devDependencies: { vitest: "^1.0.0" },
    scripts: { test: "vitest run" },
  }));
  writeFileSync(join(dir, "LICENSE"), "MIT License");
  writeFileSync(join(dir, "src", "index.ts"), "export const x = 1;");
  writeFileSync(join(dir, ".env"), "SECRET=do-not-commit");
  return dir;
}

describe("RepositoryScanner extended scan summary", () => {
  let db: Database.Database;
  let scanner: RepositoryScanner;

  beforeEach(() => {
    db = createTestDb();
    scanner = new RepositoryScanner(db);
  });

  afterEach(() => {
    delete process.env.DJIMITFLO_REPOSITORY_ROOTS;
    db.close();
  });

  it("emits secret scan, dependency manifest, license, and tags", () => {
    const repoPath = createFakeRepo();
    // .example placeholder must NOT trigger the sensitive-file finding
    writeFileSync(join(repoPath, ".env.example"), "# JWT_SECRET=[placeholder]\n");
    const result = scanner.scan(repoPath);

    expect(result.scanSummary).toBeDefined();
    expect(result.scanSummary.secretScan.clean).toBe(false);
    expect(result.scanSummary.secretScan.findings.some((f) => f.file.includes(".env"))).toBe(true);
    // the .example placeholder is documentation, not credential material
    expect(result.scanSummary.secretScan.findings.some((f) => f.file.endsWith(".env.example"))).toBe(false);

    expect(result.scanSummary.dependencyManifest.packageManager).toBe("npm");
    expect(result.scanSummary.dependencyManifest.packages.some((p) => p.name === "express")).toBe(true);

    expect(result.scanSummary.license).not.toBeNull();
    expect(result.scanSummary.license?.license).toBe("MIT");

    rmSync(repoPath, { recursive: true, force: true });
  });

  it("rejects a symlink that escapes the configured repository root", () => {
    const allowedRoot = mkdtempSync(join(tmpdir(), "repo-scanner-root-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "repo-scanner-outside-"));
    const link = join(allowedRoot, "escaped-repo");
    symlinkSync(outsideRoot, link, "dir");
    process.env.DJIMITFLO_REPOSITORY_ROOTS = allowedRoot;

    expect(() => scanner.scan(link)).toThrow("REPOSITORY_PATH_NOT_ALLOWED");

    rmSync(allowedRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  });

  it("rebinds an inactive filesystem path without duplicating repository identity", () => {
    const oldRoot = mkdtempSync(join(tmpdir(), "repo-scanner-old-"));
    const newRoot = mkdtempSync(join(tmpdir(), "repo-scanner-new-"));
    const oldPath = join(oldRoot, "same-repo");
    const newPath = join(newRoot, "same-repo");
    mkdirSync(oldPath);
    mkdirSync(newPath);
    writeFileSync(join(oldPath, "package.json"), JSON.stringify({ name: "same-repo" }));
    writeFileSync(join(newPath, "package.json"), JSON.stringify({ name: "same-repo" }));

    const original = scanner.scan(oldPath).repository;
    rmSync(oldRoot, { recursive: true, force: true });
    const rebound = scanner.scan(newPath).repository;

    expect(rebound.id).toBe(original.id);
    expect(rebound.path).toBe(realpathSync(newPath));
    expect((db.prepare("SELECT COUNT(*) AS count FROM repositories").get() as any).count).toBe(1);
    rmSync(newRoot, { recursive: true, force: true });
  });

  it("records deployment provenance only for the exact clean runtime commit", () => {
    const repoPath = createFakeRepo();
    const repository = scanner.scan(repoPath).repository;
    const commit = "a".repeat(40);
    db.prepare("UPDATE repositories SET status = 'clean', git_commit = ? WHERE id = ?").run(commit, repository.id);
    const previous = process.env.DJIMITFLO_COMMIT_SHA;
    process.env.DJIMITFLO_COMMIT_SHA = commit;
    try {
      const recorded = scanner.recordDeploymentProvenance(repository.id, {
        commit,
        source_archive_sha256: "b".repeat(64),
        image_digest: `sha256:${"c".repeat(64)}`,
        runtime_instance: "test-runtime",
        canonical_source_state: "REVIEW_REQUIRED",
        verified_by: "test-approver",
      });
      expect(recorded.metadata.deployment_provenance).toMatchObject({ status: "VERIFIED", commit, verified_by: "test-approver" });
      expect(() => scanner.recordDeploymentProvenance(repository.id, {
        commit: "d".repeat(40),
        source_archive_sha256: "b".repeat(64),
        image_digest: `sha256:${"c".repeat(64)}`,
        runtime_instance: "test-runtime",
        canonical_source_state: "REVIEW_REQUIRED",
        verified_by: "test-approver",
      })).toThrow("DEPLOYMENT_SOURCE_MISMATCH");
    } finally {
      if (previous === undefined) delete process.env.DJIMITFLO_COMMIT_SHA;
      else process.env.DJIMITFLO_COMMIT_SHA = previous;
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
