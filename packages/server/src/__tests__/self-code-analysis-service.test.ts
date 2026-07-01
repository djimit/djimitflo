import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SelfCodeAnalysisService } from '../services/self-code-analysis-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let analyzer: SelfCodeAnalysisService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  analyzer = new SelfCodeAnalysisService(db);
});

afterEach(() => {
  db?.close();
});

describe('G82: Self Code Analysis', () => {
  it('analyzes codebase', () => {
    const report = analyzer.analyze();
    expect(report).toBeDefined();
    expect(report.totalFiles).toBeGreaterThan(0);
    expect(report.totalLines).toBeGreaterThan(0);
  });

  it('finds test coverage gaps', () => {
    const report = analyzer.analyze();
    expect(Array.isArray(report.testCoverageGaps)).toBe(true);
  });

  it('generates recommendations', () => {
    const report = analyzer.analyze();
    expect(report.recommendations.length).toBeGreaterThan(0);
  });

  it('persists report', () => {
    analyzer.analyze();
    const latest = analyzer.getLatestReport();
    expect(latest).not.toBeNull();
  });

  it('finds complexity hotspots', () => {
    const report = analyzer.analyze();
    expect(Array.isArray(report.complexityHotspots)).toBe(true);
  });

  it('scans source files', () => {
    const report = analyzer.analyze();
    expect(report.totalFiles).toBeGreaterThan(0);
  });
});
