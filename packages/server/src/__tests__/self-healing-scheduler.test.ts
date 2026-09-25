import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SelfHealingScheduler } from '../services/self-healing-scheduler';

describe('SelfHealingScheduler', () => {
  let db: Database.Database;
  let scheduler: SelfHealingScheduler;
  const prevEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    scheduler = new SelfHealingScheduler(db);
    for (const key of ['SELF_HEALING_SCHEDULER_ENABLED', 'SELF_HEALING_INTERVAL_MINUTES']) {
      prevEnv[key] = process.env[key];
      delete process.env[key];
    }
    db.prepare(`
      INSERT INTO loop_runs (id, loop_name, mode, status)
      VALUES ('fixture-run', 'doc-drift-and-small-fix-loop', 'closed', 'running')
    `).run();
  });

  afterEach(() => {
    scheduler.stop();
    db.close();
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function insertStaleLease(id: string) {
    db.prepare(`
      INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, updated_at)
      VALUES (?, 'fixture-run', 'maker', 'mock', 'running', datetime('now', '-2 hours'))
    `).run(id);
  }

  it('does not arm when disabled (default off)', () => {
    insertStaleLease('lease-1');
    expect(scheduler.start()).toBe(false);
    const status = (db.prepare("SELECT status FROM worker_leases WHERE id = 'lease-1'").get() as { status: string }).status;
    expect(status).toBe('running');
  });

  it('arms and cancels a stale worker lease on the catch-up tick when enabled', () => {
    insertStaleLease('lease-1');
    process.env.SELF_HEALING_SCHEDULER_ENABLED = 'true';
    expect(scheduler.start()).toBe(true);
    const status = (db.prepare("SELECT status FROM worker_leases WHERE id = 'lease-1'").get() as { status: string }).status;
    expect(status).toBe('cancelled');
  });

  it('leaves a fresh (non-stale) worker lease alone', () => {
    db.prepare(`
      INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, updated_at)
      VALUES ('lease-fresh', 'fixture-run', 'maker', 'mock', 'running', datetime('now'))
    `).run();
    process.env.SELF_HEALING_SCHEDULER_ENABLED = 'true';
    scheduler.tick();
    const status = (db.prepare("SELECT status FROM worker_leases WHERE id = 'lease-fresh'").get() as { status: string }).status;
    expect(status).toBe('running');
  });

  it('does not throw if heal() fails', () => {
    const failing = new SelfHealingScheduler(db, { heal: () => { throw new Error('boom'); } });
    process.env.SELF_HEALING_SCHEDULER_ENABLED = 'true';
    expect(() => failing.start()).not.toThrow();
  });

  it('falls back to a 30-minute interval for invalid configuration', () => {
    process.env.SELF_HEALING_INTERVAL_MINUTES = 'not-a-number';
    expect(scheduler.intervalMinutes()).toBe(30);
    process.env.SELF_HEALING_INTERVAL_MINUTES = '-5';
    expect(scheduler.intervalMinutes()).toBe(30);
  });
});
