import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { UsageTelemetry, liveUsageTelemetry, MAX_BUFFERED_KEYS } from '../services/usage-telemetry';
import type { Database as DB } from 'better-sqlite3';

let db: DB;
beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => { db.close(); });

describe('MAX_BUFFERED_KEYS', () => {
  it('is exported as a positive integer cap', () => {
    expect(typeof MAX_BUFFERED_KEYS).toBe('number');
    expect(Number.isInteger(MAX_BUFFERED_KEYS)).toBe(true);
    expect(MAX_BUFFERED_KEYS).toBeGreaterThan(0);
  });
});

describe('liveUsageTelemetry', () => {
  it('returns undefined for a db that never registered a UsageTelemetry', () => {
    expect(liveUsageTelemetry(db)).toBeUndefined();
  });

  it('returns the instance registered by the constructor (flushMs > 0)', () => {
    const t = new UsageTelemetry(db, 0); // flushMs 0 => no registration
    expect(liveUsageTelemetry(db)).toBeUndefined();
    t.stop();

    const t2 = new UsageTelemetry(db, 60_000);
    expect(liveUsageTelemetry(db)).toBe(t2);
    t2.stop();
  });

  it('returns the first registered instance when several share the same db', () => {
    const a = new UsageTelemetry(db, 60_000);
    const b = new UsageTelemetry(db, 60_000);
    expect(liveUsageTelemetry(db)).toBe(a);
    a.stop();
    b.stop();
  });

  it('is cleared after stop() of the owning instance', () => {
    const t = new UsageTelemetry(db, 60_000);
    t.stop();
    expect(liveUsageTelemetry(db)).toBeUndefined();
  });
});

describe('UsageTelemetry.count / summary', () => {
  it('counts api hits and reports them grouped by kind/name/method after flush', () => {
    const t = new UsageTelemetry(db, 0);
    t.count('api', '/api/goals/:id', 'GET', '2xx');
    t.count('api', '/api/goals/:id', 'GET', '2xx');
    t.count('api', '/api/goals/:id', 'POST', '5xx');
    t.count('page', '/dashboard');
    const rows = t.summary(14);
    expect(rows).toHaveLength(3);
    const get = rows.find((r) => r.method === 'GET' && r.name === '/api/goals/:id')!;
    expect(get.hits).toBe(2);
    expect(get.errors).toBe(0);
    expect(get.kind).toBe('api');
    const post = rows.find((r) => r.method === 'POST' && r.name === '/api/goals/:id')!;
    expect(post.hits).toBe(1);
    expect(post.errors).toBe(1);
    const page = rows.find((r) => r.kind === 'page')!;
    expect(page.hits).toBe(1);
    expect(page.errors).toBe(0);
    t.stop();
  });

  it('respects the days window (older counts excluded)', () => {
    const t = new UsageTelemetry(db, 0);
    // Backdate rows directly so they fall outside a 1-day window.
    db.prepare(`INSERT INTO usage_counts (day, kind, name, method, status_class, count) VALUES (?, 'api', '/old', 'GET', '2xx', 5)`)
      .run('2020-01-01');
    t.count('api', '/new', 'GET', '2xx');
    const rows = t.summary(1);
    expect(rows.every((r) => r.name === '/new')).toBe(true);
    expect(rows).toHaveLength(1);
    t.stop();
  });
});

describe('UsageTelemetry.coverage', () => {
  it('reports incomplete=false and dropped_count=0 when nothing is dropped or buffered', () => {
    const t = new UsageTelemetry(db, 0);
    t.count('api', '/x', 'GET', '2xx');
    t.flush();
    const c = t.coverage(14);
    expect(c.dropped_count).toBe(0);
    expect(c.incomplete).toBe(false);
    t.stop();
  });

  it('reports incomplete=true while counts are buffered (not yet flushed)', () => {
    const t = new UsageTelemetry(db, 0);
    t.count('api', '/x', 'GET', '2xx');
    const c = t.coverage(14);
    expect(c.incomplete).toBe(true);
    t.flush();
    const c2 = t.coverage(14);
    expect(c2.incomplete).toBe(false);
    t.stop();
  });

  it('counts dropped rows past the buffer cap in dropped_count', () => {
    const t = new UsageTelemetry(db, 0);
    // Fill exactly to the cap, then add one distinct key to force a drop.
    for (let i = 0; i < MAX_BUFFERED_KEYS; i++) t.count('api', `/k${i}`, 'GET', '2xx');
    t.count('api', '/overflow', 'GET', '2xx');
    const c = t.coverage(14);
    expect(c.dropped_count).toBeGreaterThanOrEqual(1);
    expect(c.incomplete).toBe(true);
    t.stop();
  });
});

describe('UsageTelemetry.middleware', () => {
  it('counts the matched route pattern with method and status class on res finish', () => {
    const t = new UsageTelemetry(db, 0);
    const mw = t.middleware();
    const req: any = { baseUrl: '/api', route: { path: '/goals/:id' }, method: 'GET' };
    const res: any = { statusCode: 200, on: (ev: string, cb: () => void) => { if (ev === 'finish') cb(); } };
    mw(req, res, () => {});
    const rows = t.summary(14);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('/api/goals/:id');
    expect(rows[0].method).toBe('GET');
    expect(rows[0].hits).toBe(1);
    t.stop();
  });

  it('counts (unmatched) when no route is matched', () => {
    const t = new UsageTelemetry(db, 0);
    const mw = t.middleware();
    const req: any = { baseUrl: '', route: undefined, method: 'GET' };
    const res: any = { statusCode: 404, on: (ev: string, cb: () => void) => { if (ev === 'finish') cb(); } };
    mw(req, res, () => {});
    const rows = t.summary(14);
    expect(rows[0].name).toBe('(unmatched)');
    expect(rows[0].errors).toBe(1);
    t.stop();
  });
});

describe('UsageTelemetry.flush (rollback re-queue)', () => {
  it('re-queues counts when the write transaction throws, so a later flush persists them', () => {
    const t = new UsageTelemetry(db, 0);
    // Drop the tables so the flush transaction throws.
    db.exec('DROP TABLE usage_counts; DROP TABLE usage_loss;');
    t.count('api', '/x', 'GET', '2xx');
    expect(() => t.flush()).not.toThrow(); // swallowed internally
    // Recreate tables and flush again; the re-queued count should land.
    db.exec(`CREATE TABLE IF NOT EXISTS usage_counts (
      day TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, method TEXT NOT NULL DEFAULT '', status_class TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL,
      PRIMARY KEY (day, kind, name, method, status_class));
      CREATE TABLE IF NOT EXISTS usage_loss (day TEXT PRIMARY KEY, dropped INTEGER NOT NULL)`);
    t.flush();
    const rows = t.summary(14);
    expect(rows).toHaveLength(1);
    expect(rows[0].hits).toBe(1);
    t.stop();
  });
});