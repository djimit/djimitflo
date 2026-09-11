import { afterEach, describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createTestDb } from "./helpers/test-db";
import { RepositoryScanner } from "../services/repository-scanner";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { AgentsMdValidator } from "../services/agents-md-validator";
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

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

  it("persists first-scan git identity and round-trips nested instruction contracts", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-scanner-real-"));
    try {
      mkdirSync(join(dir, "packages", "demo"), { recursive: true });
      writeFileSync(join(dir, "AGENTS.md"), "Root test build review done protected");
      writeFileSync(join(dir, "packages", "demo", "AGENTS.md"), "Nested test build review done protected");
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { "type-check": "tsc --noEmit" } }));
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
      git('init', '-q', '-b', 'fixture'); git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
      const result = scanner.scan(dir);
      expect(scanner.getRepository(result.repository.id)).toMatchObject({ git_branch: 'fixture', git_commit: git('rev-parse', 'HEAD'), typecheck_commands: ['npm run type-check'] });
      const files = new RepositoryScanner(db).getAgentsMdFiles(result.repository.id);
      expect(files).toEqual(result.agentsMdFiles);
      const validator = new AgentsMdValidator();
      expect(validator.getEffectiveStack(result.repository.id, files, '/packages/demo/index.ts').files.map(f => f.relativePath)).toEqual(['AGENTS.md', 'packages/demo/AGENTS.md']);
      expect(validator.getEffectiveStack(result.repository.id, files, '/packages/demo-other/index.ts').files.map(f => f.relativePath)).toEqual(['AGENTS.md']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("exposes only latest scan findings while retaining historical evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-scanner-history-"));
    try {
      const first = scanner.scan(dir);
      writeFileSync(join(dir, 'AGENTS.md'), 'test build review done protected');
      const second = scanner.scan(dir);
      const actual = scanner.getHealthFindings(first.repository.id);
      expect(actual).toEqual(second.healthFindings);
      expect(actual.every(f => f.repositoryId === first.repository.id)).toBe(true);
      expect(actual.map(f => f.title)).toEqual(second.healthFindings.map(f => f.title));
      expect(actual.some(f => f.title === 'No AGENTS.md found')).toBe(false);
      expect(db.prepare('SELECT COUNT(*) AS count FROM repository_health_findings WHERE scan_id = ?').get(first.scanId)).toEqual({count: first.healthFindings.length});
      db.prepare("UPDATE repository_scans SET metadata = '{}' WHERE id = ?").run(second.scanId);
      expect(() => scanner.getHealthFindings(first.repository.id)).toThrow('Rescan required');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rolls back an incomplete rescan instead of mixing new metadata and old evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-scanner-atomic-"));
    try {
      const first = scanner.scan(dir);
      const previous = scanner.getRepository(first.repository.id);
      writeFileSync(join(dir, 'AGENTS.md'), 'test build review done protected');
      db.exec("CREATE TRIGGER fail_scan BEFORE INSERT ON repository_scans BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
      expect(() => scanner.scan(dir)).toThrow('fixture write failure');
      expect(scanner.getRepository(first.repository.id)).toEqual(previous);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('upgrades older findings tables without deleting legacy evidence', () => {
    const legacy = new Database(':memory:');
    try {
      legacy.exec(schema);
      legacy.exec('ALTER TABLE repository_health_findings DROP COLUMN scan_id');
      legacy.prepare("INSERT INTO repositories (id,name,description,path,provider) VALUES ('legacy','legacy','Historical fixture','/legacy','local')").run();
      legacy.prepare("INSERT INTO repository_health_findings (id,repository_id,severity,category,title,description,discovered_at) VALUES ('finding','legacy','warning','governance','Legacy','Historical evidence','2026-01-01')").run();
      runMigrations(legacy);
      expect(legacy.prepare("SELECT id,scan_id FROM repository_health_findings WHERE id='finding'").get()).toEqual({id:'finding',scan_id:null});
    } finally { legacy.close(); }
  });
});
