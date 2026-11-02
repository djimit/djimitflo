import { expect, it, beforeEach, afterEach, describe } from 'vitest';
import Database from 'better-sqlite3';
import { usageWindow } from '../services/swarm-learning-curve';
import { metricRef } from '../services/cost-ledger';

const NOW = Date.parse('2026-10-25T00:00:00Z');
const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

// worker_leases is the only source usageWindow reads that needs a real table; every other
// query in usageEvents is wrapped in safeAll and yields [] on a missing table.
const makeDb = () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE worker_leases (id TEXT PRIMARY KEY, loop_run_id TEXT, role TEXT, runtime TEXT, status TEXT, created_at TEXT, metadata TEXT)');
  return db;
};

const insertLease = (db: Database.Database, id: string, msAgo: number, runtime: string, total: number | null, role = 'maker') =>
  db.prepare('INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, null, role, runtime, 'completed', iso(msAgo), JSON.stringify({ runtime_usage: total !== null ? { total_tokens: total, prompt_tokens: Math.floor(total / 2), completion_tokens: Math.ceil(total / 2) } : null }),
  );

describe('usageWindow', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => db.close());

  it('reports UNKNOWN with null totals and empty by_source when there are no usage events', () => {
    const w = usageWindow(db, NOW, 7);
    expect(w.window_days).toBe(7);
    expect(w.since).toBe(new Date(NOW - 7 * DAY).toISOString());
    expect(w.until).toBe(new Date(NOW).toISOString());
    expect(w.events).toBe(0);
    expect(w.known_events).toBe(0);
    expect(w.coverage).toBeNull();
    expect(w.status).toBe('UNKNOWN');
    expect(w.total_tokens).toBeNull();
    expect(w.cloud_tokens).toBeNull();
    expect(w.local_tokens).toBeNull();
    expect(w.by_source).toEqual({});
    expect(w.mirrors_excluded).toEqual({ rows: 0, tokens: 0 });
    expect(w.metric).toEqual(metricRef('cost.usage_event'));
    expect(w.note).toMatch(/provider-reported tokens/);
  });

  it('sums reconciled tokens, splits cloud vs local and counts by_source for leases in the window', () => {
    insertLease(db, 'cloud1', 2 * DAY, 'opencode', 1000);
    insertLease(db, 'cloud2', 1 * DAY, 'opencode', 500);
    insertLease(db, 'local1', 1 * DAY, 'remote', 200);
    const w = usageWindow(db, NOW, 7);
    expect(w.events).toBe(3);
    expect(w.known_events).toBe(3);
    expect(w.coverage).toBe(1);
    expect(w.status).toBe('measured');
    expect(w.total_tokens).toBe(1700);
    expect(w.cloud_tokens).toBe(1500);
    expect(w.local_tokens).toBe(200);
    expect(w.by_source.worker_leases).toEqual({ events: 3, known: 3 });
  });

  it('excludes leases created outside [now - days, now) and reports partial coverage when some lack usage', () => {
    insertLease(db, 'in1', 3 * DAY, 'opencode', 800);
    insertLease(db, 'out1', 10 * DAY, 'opencode', 9999); // before the window
    insertLease(db, 'unreported', 1 * DAY, 'opencode', null); // in window, no reported tokens
    const w = usageWindow(db, NOW, 7);
    expect(w.events).toBe(2);
    expect(w.known_events).toBe(1);
    expect(w.coverage).toBe(0.5);
    expect(w.status).toBe('partial');
    expect(w.total_tokens).toBe(800);
    expect(w.by_source.worker_leases).toEqual({ events: 2, known: 1 });
  });

  it('uses a custom days window and excludes manual runtime leases', () => {
    insertLease(db, 'm1', 1 * DAY, 'manual', 5000);
    insertLease(db, 'ok1', 12 * DAY, 'opencode', 600); // outside a 7-day window but inside 14
    const w = usageWindow(db, NOW, 14);
    expect(w.window_days).toBe(14);
    expect(w.events).toBe(1); // manual excluded, ok1 included
    expect(w.total_tokens).toBe(600);
  });
});