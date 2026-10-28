import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SelfHealingScheduler } from '../services/self-healing-scheduler';
import { listSchedulers, noteScheduler, resetSchedulers } from '../services/scheduler-registry';

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
      VALUES ('fixture-run', 'doc-drift-and-small-fix-loop', 'closed', 'failed')
    `).run();
    db.prepare(`
      INSERT INTO loop_runs (id, loop_name, mode, status)
      VALUES ('active-run', 'doc-drift-and-small-fix-loop', 'closed', 'running')
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

  function insertStaleLease(id: string, runId = 'fixture-run') {
    db.prepare(`
      INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, updated_at)
      VALUES (?, ?, 'maker', 'mock', 'running', datetime('now', '-2 hours'))
    `).run(id, runId);
  }

  it('does not arm when disabled (default off)', () => {
    insertStaleLease('lease-1');
    expect(scheduler.start()).toBe(false);
    const status = (db.prepare("SELECT status FROM worker_leases WHERE id = 'lease-1'").get() as { status: string }).status;
    expect(status).toBe('running');
  });

  it('arms and cancels a stale worker lease on the catch-up tick when enabled', () => {
    insertStaleLease('lease-1');
    insertStaleLease('lease-of-active-run', 'active-run'); // DF-02: a run still in flight may own it — never auto-cancelled
    process.env.SELF_HEALING_SCHEDULER_ENABLED = 'true';
    expect(scheduler.start()).toBe(true);
    const status = (id: string) => (db.prepare('SELECT status FROM worker_leases WHERE id = ?').get(id) as { status: string }).status;
    expect(status('lease-1')).toBe('cancelled');
    expect(status('lease-of-active-run')).toBe('running');
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

  it('defaults to a 30-minute interval when the env var is unset', () => {
    expect(scheduler.intervalMinutes()).toBe(30);
  });

  it('uses a custom interval in minutes when configured', () => {
    process.env.SELF_HEALING_INTERVAL_MINUTES = '7';
    expect(scheduler.intervalMinutes()).toBe(7);
  });

  it('falls back to a 30-minute interval for a zero interval', () => {
    process.env.SELF_HEALING_INTERVAL_MINUTES = '0';
    expect(scheduler.intervalMinutes()).toBe(30);
  });

  it('returns the heal() result on tick', () => {
    const sentinel = { incidents: 0, actions: [] };
    const withStub = new SelfHealingScheduler(db, { heal: () => sentinel });
    expect(withStub.tick()).toBe(sentinel);
  });

  it('returns null and warns when heal() throws an Error', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = new SelfHealingScheduler(db, { heal: () => { throw new Error('boom'); } });
    expect(failing.tick()).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain('SelfHealingScheduler');
    warn.mockRestore();
  });

  it('returns null when heal() throws a non-Error value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = new SelfHealingScheduler(db, { heal: () => { throw 'string-error'; } });
    expect(failing.tick()).toBeNull();
    warn.mockRestore();
  });

  it('records its tick in the scheduler registry via markRun', () => {
    resetSchedulers();
    noteScheduler('self_healing', 'SELF_HEALING_SCHEDULER_ENABLED', true, 30 * 60_000);
    scheduler.tick();
    const info = listSchedulers().schedulers.find((s) => s.name === 'self_healing');
    expect(info?.last_run).not.toBeNull();
    resetSchedulers();
  });

  it('schedules the interval at intervalMinutes()*MINUTE_MS and unrefs the timer', () => {
    process.env.SELF_HEALING_SCHEDULER_ENABLED = 'true';
    process.env.SELF_HEALING_INTERVAL_MINUTES = '5';
    const delays: number[] = [];
    const captured: (() => void)[] = [];
    const unref = vi.fn();
    const fakeTimer = { unref, ref() { return fakeTimer; }, hasRef() { return true; } };
    const origSetInterval = global.setInterval;
    const origClearInterval = global.clearInterval;
    global.setInterval = ((fn: () => void, delay: number) => { delays.push(delay); captured.push(fn); return fakeTimer; }) as typeof global.setInterval;
    global.clearInterval = (() => {}) as typeof global.clearInterval;
    try {
      expect(scheduler.start()).toBe(true);
    } finally {
      global.setInterval = origSetInterval;
      global.clearInterval = origClearInterval;
    }
    expect(delays).toEqual([5 * 60 * 1000]);
    expect(unref).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('the armed interval callback invokes heal() (not a no-op)', () => {
    let healCalls = 0;
    const withStub = new SelfHealingScheduler(db, { heal: () => { healCalls++; return null; } });
    process.env.SELF_HEALING_SCHEDULER_ENABLED = 'true';
    const captured: (() => void)[] = [];
    const fakeTimer = { unref() {}, ref() { return fakeTimer; }, hasRef() { return true; } };
    const origSetInterval = global.setInterval;
    const origClearInterval = global.clearInterval;
    global.setInterval = ((fn: () => void) => { captured.push(fn); return fakeTimer; }) as typeof global.setInterval;
    global.clearInterval = (() => {}) as typeof global.clearInterval;
    try {
      withStub.start();
    } finally {
      global.setInterval = origSetInterval;
      global.clearInterval = origClearInterval;
    }
    expect(healCalls).toBe(1); // catch-up tick on boot
    captured[0]();
    expect(healCalls).toBe(2); // the armed interval callback actually ran heal()
    withStub.stop();
  });

  it('stop() clears the armed interval timer', () => {
    process.env.SELF_HEALING_SCHEDULER_ENABLED = 'true';
    const cleared: unknown[] = [];
    const fakeTimer = { unref() {}, ref() { return fakeTimer; }, hasRef() { return true; } };
    const origSetInterval = global.setInterval;
    const origClearInterval = global.clearInterval;
    global.setInterval = (() => fakeTimer) as typeof global.setInterval;
    global.clearInterval = ((t: unknown) => { cleared.push(t); }) as typeof global.clearInterval;
    try {
      scheduler.start();
      scheduler.stop();
    } finally {
      global.setInterval = origSetInterval;
      global.clearInterval = origClearInterval;
    }
    expect(cleared).toEqual([fakeTimer]);
  });

  it('stop() is a no-op when the scheduler was never started', () => {
    const cleared: unknown[] = [];
    const origClearInterval = global.clearInterval;
    global.clearInterval = ((t: unknown) => { cleared.push(t); }) as typeof global.clearInterval;
    try {
      scheduler.stop();
    } finally {
      global.clearInterval = origClearInterval;
    }
    expect(cleared).toHaveLength(0);
  });
});
