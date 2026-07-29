import { afterEach, describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SelfModificationPipeline } from '../services/self-modification-pipeline';

describe('SelfModificationPipeline', () => {
  let db: Database.Database;
  let pipeline: SelfModificationPipeline;
  let tempDir: string | undefined;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    pipeline = new SelfModificationPipeline(db);
  });

  afterEach(() => {
    db.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('analyzes codebase for improvement opportunities', () => {
    const opportunities = pipeline.analyze();
    expect(Array.isArray(opportunities)).toBe(true);
  });

  it('creates a modification plan for an opportunity', () => {
    const opportunities = pipeline.analyze();
    if (opportunities.length > 0) {
      const plan = pipeline.createPlan(opportunities[0].id);
      expect(plan).toBeDefined();
      if (plan) {
        expect(plan.opportunityId).toBe(opportunities[0].id);
        expect(plan.changes.length).toBeGreaterThan(0);
      }
    }
  });

  it('returns null for non-existent opportunity', () => {
    const plan = pipeline.createPlan('nonexistent-id');
    expect(plan).toBeNull();
  });

  it('provides status summary', () => {
    const status = pipeline.getStatus();
    expect(status.opportunities).toBeDefined();
    expect(status.plans).toBeDefined();
    expect(status.implemented).toBeDefined();
    expect(status.rejected).toBeDefined();
  });

  it('stores opportunities in database', () => {
    pipeline.analyze();

    const rows = db.prepare('SELECT * FROM self_modification_opportunities').all();
    expect(Array.isArray(rows)).toBe(true);
  });

  it('stores plans in database', () => {
    const opportunities = pipeline.analyze();
    if (opportunities.length > 0) {
      pipeline.createPlan(opportunities[0].id);

      const rows = db.prepare('SELECT * FROM self_modification_plans').all();
      expect(rows.length).toBeGreaterThan(0);
    }
  });

  it('keeps repeated findings stable and recognizes imported route tests', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'self-modification-'));
    const services = join(tempDir, 'packages/server/src/services');
    const routes = join(tempDir, 'packages/server/src/routes');
    const tests = join(tempDir, 'packages/server/src/__tests__');
    mkdirSync(services, { recursive: true });
    mkdirSync(routes, { recursive: true });
    mkdirSync(tests, { recursive: true });
    writeFileSync(join(services, 'large.ts'), Array(900).fill('// line').join('\n'));
    writeFileSync(join(routes, 'covered.ts'), 'export const covered = true;\n');
    writeFileSync(join(tests, 'integration.test.ts'), "import { covered } from '../routes/covered';\nvoid covered;\n");

    const isolated = new SelfModificationPipeline(db, tempDir);
    const first = isolated.analyze();
    const firstCount = (db.prepare("SELECT COUNT(*) c FROM self_modification_opportunities WHERE resolved_at IS NULL").get() as { c: number }).c;
    const second = isolated.analyze();
    const secondCount = (db.prepare("SELECT COUNT(*) c FROM self_modification_opportunities WHERE resolved_at IS NULL").get() as { c: number }).c;

    expect(first.map((finding) => finding.id)).toEqual(second.map((finding) => finding.id));
    expect(secondCount).toBe(firstCount);
    expect(second.some((finding) => finding.file === 'total')).toBe(false);
    expect(second.some((finding) => finding.file.endsWith('covered.ts') && finding.type === 'test_gap')).toBe(false);
  });

  it('compacts unreferenced legacy duplicates without losing observation history', () => {
    const insert = db.prepare(`
      INSERT INTO self_modification_opportunities
      (id, type, severity, file_path, description, suggestion, estimated_effort, detected_at)
      VALUES (?, 'test_gap', 'medium', 'routes/example.ts', 'legacy gap', 'test it', '1h', ?)
    `);
    insert.run('legacy-1', '2026-01-01T00:00:00.000Z');
    insert.run('legacy-2', '2026-01-02T00:00:00.000Z');

    new SelfModificationPipeline(db);
    const rows = db.prepare("SELECT analyzer_version, seen_count, first_seen_at, last_seen_at FROM self_modification_opportunities WHERE description = 'legacy gap'").all();
    expect(rows).toEqual([{
      analyzer_version: 'v2',
      seen_count: 2,
      first_seen_at: '2026-01-01T00:00:00.000Z',
      last_seen_at: '2026-01-02T00:00:00.000Z',
    }]);
  });
});
