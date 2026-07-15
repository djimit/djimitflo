import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Database } from 'better-sqlite3';
import { createTestDb } from './helpers/test-db';
import { ReconciliationService } from '../services/reconciliation-service';

function makeFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'reconcile-'));
  const services = join(root, 'packages', 'server', 'src', 'services');
  const tests = join(root, 'packages', 'server', 'src', '__tests__');
  mkdirSync(services, { recursive: true });
  mkdirSync(tests, { recursive: true });

  // a big file (600 lines) and a small one (50 lines)
  writeFileSync(join(services, 'big-service.ts'), Array(600).fill('// line').join('\n'));
  writeFileSync(join(services, 'small-service.ts'), Array(50).fill('// line').join('\n'));
  // execSync call sites: one safe, one unsafe
  writeFileSync(join(services, 'shelly.ts'), [
    "const a = execSync('ls', {", "  encoding: 'utf8',", '  timeout: 10_000,', '});',
    "const b = execSync('pwd', {", "  encoding: 'utf8',", '});',
  ].join('\n'));
  // an existing test file
  writeFileSync(join(tests, 'execution-engine.test.ts'), '// covered');
  return root;
}

describe('ReconciliationService', () => {
  let db: Database;
  let repoRoot: string;
  let service: ReconciliationService;

  beforeEach(() => {
    db = createTestDb();
    repoRoot = makeFixtureRepo();
    service = new ReconciliationService(db, repoRoot);
  });

  afterEach(() => {
    db.close();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  describe('claim checkers', () => {
    it('LOC claim still valid when the file is still big', () => {
      const verdict = service.verifyClaim('[Refactor] Reduce complexity in big-service.ts (600 LOC)');
      expect(verdict.checker).toBe('loc');
      expect(verdict.stillValid).toBe(true);
    });

    it('LOC claim stale when the file was materially reduced', () => {
      const verdict = service.verifyClaim('[Refactor] Reduce complexity in small-service.ts (799 LOC)');
      expect(verdict.stillValid).toBe(false);
      expect(verdict.evidence).toContain('50 LOC');
    });

    it('LOC claim stale when the file is gone', () => {
      const verdict = service.verifyClaim('[Refactor] Reduce complexity in deleted-service.ts (1000 LOC)');
      expect(verdict.stillValid).toBe(false);
      expect(verdict.evidence).toContain('no longer exists');
    });

    it('test-coverage claim stale when a matching test file exists', () => {
      const verdict = service.verifyClaim('[Test Coverage] Add tests for execution-engine.ts');
      expect(verdict.checker).toBe('test-coverage');
      expect(verdict.stillValid).toBe(false);
      expect(verdict.evidence).toContain('execution-engine.test.ts');
    });

    it('test-coverage claim valid when nothing matches', () => {
      const verdict = service.verifyClaim('[Test Coverage] Add tests for quantum-flux-capacitor.ts');
      expect(verdict.stillValid).toBe(true);
    });

    it('exec-timeout claim valid while an unsafe call site remains', () => {
      const verdict = service.verifyClaim('[Security] execSync calls without timeout — potential DoS');
      expect(verdict.checker).toBe('exec-timeout');
      expect(verdict.stillValid).toBe(true);
      expect(verdict.evidence).toContain('shelly.ts');
    });

    it('exec-timeout claim stale once every call site has a timeout', () => {
      writeFileSync(join(repoRoot, 'packages', 'server', 'src', 'services', 'shelly.ts'),
        "const a = execSync('ls', { timeout: 5000 });\nconst b = execSync('pwd', { timeout: 5000 });");
      const verdict = service.verifyClaim('[Security] execSync calls without timeout — potential DoS');
      expect(verdict.stillValid).toBe(false);
    });

    it('reports unknown claims as unverifiable', () => {
      const verdict = service.verifyClaim('Make the product better');
      expect(verdict.checker).toBe('unverifiable');
      expect(verdict.stillValid).toBeNull();
    });
  });

  describe('reconcile', () => {
    it('aggregates verdicts, computes generator precision, and persists the run', () => {
      const report = service.reconcile([
        { title: '[Refactor] Reduce complexity in big-service.ts (600 LOC)', issueNumber: 1 },   // valid
        { title: '[Refactor] Reduce complexity in small-service.ts (799 LOC)', issueNumber: 2 }, // stale
        { title: '[Test Coverage] Add tests for execution-engine.ts', issueNumber: 3 },          // stale
        { title: 'Make the product better', issueNumber: 4 },                                    // unverifiable
      ]);

      expect(report.totalClaims).toBe(4);
      expect(report.staleClaims).toBe(2);
      expect(report.validClaims).toBe(1);
      expect(report.unverifiableClaims).toBe(1);
      expect(report.generatorPrecision).toBeCloseTo(1 / 3, 3);

      const latest = service.latestReport();
      expect(latest?.id).toBe(report.id);
      expect(latest?.verdicts).toHaveLength(4);
    });
  });

  describe('reconcileGitHub', () => {
    const ENV = { ...process.env };
    afterEach(() => {
      for (const key of Object.keys(process.env)) if (!(key in ENV)) delete process.env[key];
      Object.assign(process.env, ENV);
    });

    it('report-only mode never writes to GitHub', async () => {
      process.env.GITHUB_REPOSITORY = 'djimit/djimitflo';
      process.env.GITHUB_TOKEN = 'test-token';
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true, status: 200,
        json: async () => [
          { number: 30, title: '[Security] execSync calls without timeout — potential DoS' },
          { number: 37, title: '[Refactor] Reduce complexity in small-service.ts (799 LOC)' },
        ],
      });
      const svc = new ReconciliationService(db, repoRoot, fetchMock as any);

      const report = await svc.reconcileGitHub();

      expect(fetchMock).toHaveBeenCalledTimes(1); // only the list call
      expect(report.applied).toBe(false);
      expect(report.closedIssues).toEqual([]);
      expect(report.staleClaims).toBe(1); // #37; #30 still valid in the fixture
    });

    it('apply mode comments on and closes only the stale issues', async () => {
      process.env.GITHUB_REPOSITORY = 'djimit/djimitflo';
      process.env.GITHUB_TOKEN = 'test-token';
      const calls: Array<{ url: string; method?: string }> = [];
      const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method });
        if (!init?.method) {
          return { ok: true, status: 200, json: async () => [
            { number: 30, title: '[Security] execSync calls without timeout — potential DoS' }, // valid → untouched
            { number: 37, title: '[Refactor] Reduce complexity in small-service.ts (799 LOC)' }, // stale → closed
          ] };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      });
      const svc = new ReconciliationService(db, repoRoot, fetchMock as any);

      const report = await svc.reconcileGitHub({ apply: true });

      expect(report.closedIssues).toEqual([37]);
      const writes = calls.filter((c) => c.method);
      expect(writes).toHaveLength(2); // one comment + one close, both for #37
      expect(writes.every((c) => c.url.includes('/issues/37'))).toBe(true);
    });

    it('requires repository and token env', async () => {
      delete process.env.GITHUB_REPOSITORY;
      await expect(service.reconcileGitHub()).rejects.toThrow('GITHUB_REPOSITORY_REQUIRED');
    });
  });

  describe('nightly cadence', () => {
    const ENV = { ...process.env };
    const NIGHTLY_KEYS = ['RECONCILIATION_NIGHTLY_ENABLED', 'RECONCILIATION_NIGHTLY_HOUR', 'RECONCILIATION_NIGHTLY_APPLY', 'GITHUB_REPOSITORY', 'GITHUB_TOKEN'];

    beforeEach(() => {
      for (const key of NIGHTLY_KEYS) delete process.env[key];
    });

    afterEach(() => {
      service.stop();
      for (const key of Object.keys(process.env)) if (!(key in ENV)) delete process.env[key];
      Object.assign(process.env, ENV);
    });

    function at(hour: number): Date {
      const d = new Date();
      d.setHours(hour, 30, 0, 0);
      return d;
    }

    it('does not arm unless enabled with GitHub credentials', () => {
      expect(service.start()).toBe(false);

      process.env.RECONCILIATION_NIGHTLY_ENABLED = 'true';
      expect(service.start()).toBe(false); // no repo/token

      process.env.GITHUB_REPOSITORY = 'djimit/djimitflo';
      process.env.GITHUB_TOKEN = 'test-token';
      process.env.RECONCILIATION_NIGHTLY_HOUR = '23'; // boot tick stays a no-op
      expect(service.start()).toBe(true);
    });

    it('is due after the target hour and dedupes on a same-day github run', () => {
      process.env.RECONCILIATION_NIGHTLY_HOUR = '4';
      expect(service.shouldRun(at(3))).toBe(false);
      expect(service.shouldRun(at(5))).toBe(true);

      // a github-sourced run recorded today makes it not due
      service.reconcile([{ title: 'x' }], 'github:djimit/djimitflo');
      expect(service.shouldRun(at(5))).toBe(false);

      // manual runs do not consume the nightly slot
      db.prepare("DELETE FROM reconciliation_runs").run();
      service.reconcile([{ title: 'x' }], 'manual');
      expect(service.shouldRun(at(5))).toBe(true);
    });

    it('tick runs a github reconciliation honoring the apply flag', async () => {
      process.env.GITHUB_REPOSITORY = 'djimit/djimitflo';
      process.env.GITHUB_TOKEN = 'test-token';
      process.env.RECONCILIATION_NIGHTLY_HOUR = '0';
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] });
      const svc = new ReconciliationService(db, repoRoot, fetchMock as any);

      const report = await svc.tick(at(12));
      expect(report?.applied).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // deduped: second tick same day is a no-op
      expect(await svc.tick(at(13))).toBeNull();
    });
  });
});
