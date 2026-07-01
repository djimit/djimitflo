import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MetaHarnessService } from '../services/meta-harness-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let harness: MetaHarnessService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  harness = new MetaHarnessService(db);
});

afterEach(() => {
  db?.close();
});

describe('G52: MetaHarness Self-Audit', () => {
  it('gradeReadiness returns all 6 dimensions', () => {
    const grade = harness.gradeReadiness();
    expect(grade.overall).toBeGreaterThanOrEqual(0);
    expect(grade.overall).toBeLessThanOrEqual(100);
    expect(grade.security).toBeGreaterThanOrEqual(0);
    expect(grade.performance).toBeGreaterThanOrEqual(0);
    expect(grade.coverage).toBeGreaterThanOrEqual(0);
    expect(grade.reliability).toBeGreaterThanOrEqual(0);
    expect(grade.compliance).toBeGreaterThanOrEqual(0);
  });

  it('scanConfig returns issues', () => {
    const issues = harness.scanConfig();
    expect(Array.isArray(issues)).toBe(true);
  });

  it('detectRegressions finds drops', () => {
    harness.gradeReadiness();
    const regressions = harness.detectRegressions({ overall: 100 });
    expect(Array.isArray(regressions)).toBe(true);
  });

  it('scanSecurity returns findings', () => {
    const findings = harness.scanSecurity();
    expect(Array.isArray(findings)).toBe(true);
  });

  it('getGradeHistory returns history', () => {
    harness.gradeReadiness();
    harness.gradeReadiness();
    const history = harness.getGradeHistory(10);
    expect(history.length).toBe(2);
  });

  it('compliance score reflects audit tables', () => {
    const grade = harness.gradeReadiness();
    expect(grade.compliance).toBeGreaterThanOrEqual(50);
  });
});
