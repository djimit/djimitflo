import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ComplianceReportScheduler } from '../services/compliance-report-scheduler';

describe('ComplianceReportScheduler', () => {
  let db: Database.Database;
  let scheduler: ComplianceReportScheduler;
  const prevEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    scheduler = new ComplianceReportScheduler(db);
    for (const key of ['COMPLIANCE_REPORT_SCHEDULER_ENABLED', 'COMPLIANCE_REPORT_TYPE', 'COMPLIANCE_REPORT_INTERVAL_HOURS']) {
      prevEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    scheduler.stop();
    db.close();
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('does not arm when disabled (default off)', () => {
    expect(scheduler.start()).toBe(false);
    const count = (db.prepare('SELECT COUNT(*) as c FROM compliance_reports').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('arms and generates a report on the catch-up tick when enabled', () => {
    process.env.COMPLIANCE_REPORT_SCHEDULER_ENABLED = 'true';
    expect(scheduler.start()).toBe(true);
    const count = (db.prepare('SELECT COUNT(*) as c FROM compliance_reports').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('defaults to type custom and does not re-generate within the interval', () => {
    process.env.COMPLIANCE_REPORT_TYPE = 'not-a-real-type';
    expect(scheduler.reportType()).toBe('custom');

    const first = scheduler.tick();
    expect(first).not.toBeNull();
    const second = scheduler.tick();
    expect(second).toBeNull();

    const count = (db.prepare('SELECT COUNT(*) as c FROM compliance_reports').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('generates again once the configured interval has passed', () => {
    process.env.COMPLIANCE_REPORT_INTERVAL_HOURS = '1';
    scheduler.tick();
    db.prepare("UPDATE compliance_reports SET generated_at = datetime('now', '-2 hours')").run();
    const second = scheduler.tick();
    expect(second).not.toBeNull();
  });

  it('does not throw if report generation fails', () => {
    const failing = new ComplianceReportScheduler(db, { generateReport: () => { throw new Error('boom'); } });
    process.env.COMPLIANCE_REPORT_SCHEDULER_ENABLED = 'true';
    expect(() => failing.start()).not.toThrow();
  });

  it('falls back to a 24h interval for invalid configuration', () => {
    process.env.COMPLIANCE_REPORT_INTERVAL_HOURS = 'not-a-number';
    expect(scheduler.intervalHours()).toBe(24);
    process.env.COMPLIANCE_REPORT_INTERVAL_HOURS = '-5';
    expect(scheduler.intervalHours()).toBe(24);
  });
});
