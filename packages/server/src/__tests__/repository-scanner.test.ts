import { afterEach, describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createTestDb } from "./helpers/test-db";
import { RepositoryScanner } from "../services/repository-scanner";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from "fs";
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
    const result = scanner.scan(repoPath);

    expect(result.scanSummary).toBeDefined();
    expect(result.scanSummary.secretScan.clean).toBe(false);
    expect(result.scanSummary.secretScan.findings.some((f) => f.file.includes(".env"))).toBe(true);

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
});
