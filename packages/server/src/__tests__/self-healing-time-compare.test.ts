/**
 * DF-02 (docs/audits/djimitflo-ux/H-prioritized-backlog.md): self-healing compared ISO-8601 text
 * (`2026-10-23T10:00:00.000Z`) with SQLite `datetime('now', ...)` text (`2026-10-23 11:00:00`). 'T' sorts after ' ', so a
 * same-day ISO row never looked stale and a 24 h window over-counted rows from earlier on the cutoff day. Detection now
 * compares julianday() on both sides. The repair that cancels leases must not become more destructive than before.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SelfHealingService } from '../services/self-healing-service';
import { RuntimeLeaseRegistry } from '../services/loop-recovery-service';

const NOW = new Date('2026-10-23T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const H = 60 * 60 * 1000;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE loop_runs (id TEXT PRIMARY KEY, loop_name TEXT, status TEXT DEFAULT 'created', metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE worker_leases (id TEXT PRIMARY KEY, loop_run_id TEXT, role TEXT, runtime TEXT DEFAULT 'codex',
      status TEXT DEFAULT 'prepared', metadata TEXT DEFAULT '{}', created_at TEXT, updated_at TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT);
  `);
  return db;
}

function addLease(db: Database.Database, id: string, updatedAt: string | null, extra: { status?: string; runtime?: string; run?: string | null; metadata?: object } = {}) {
  db.prepare('INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, extra.run ?? null, 'maker', extra.runtime ?? 'codex', extra.status ?? 'prepared', JSON.stringify(extra.metadata ?? {}), updatedAt, updatedAt);
}

const staleCount = (svc: SelfHealingService) => {
  const msg = svc.checkHealth().find((c) => c.name === 'stale_leases')!.message;
  return Number(/^(\d+) stale/.exec(msg)![1]);
};
const loopTotal = (svc: SelfHealingService) => {
  const msg = svc.checkHealth().find((c) => c.name === 'loop_failure_rate')!.message;
  return Number(/\/(\d+)\)$/.exec(msg)![1]);
};
const status = (db: Database.Database, id: string) => (db.prepare('SELECT status FROM worker_leases WHERE id = ?').get(id) as { status: string }).status;

describe('SelfHealingService time comparisons (DF-02)', () => {
  let db: Database.Database;
  let svc: SelfHealingService;

  beforeEach(() => {
    db = makeDb();
    svc = new SelfHealingService(db, () => NOW);
  });
  afterEach(() => RuntimeLeaseRegistry.clear());

  describe('stale lease detection', () => {
    it('counts a same-day ISO lease last updated 2 h ago', () => {
      addLease(db, 'l1', ago(2 * H));
      expect(staleCount(svc)).toBe(1);
    });

    it('does not count a lease updated 30 min ago', () => {
      addLease(db, 'l1', ago(H / 2));
      expect(staleCount(svc)).toBe(0);
    });

    it('treats exactly 1 h as not stale and 1 h + 1 ms as stale', () => {
      addLease(db, 'edge', ago(H));
      expect(staleCount(svc)).toBe(0);
      addLease(db, 'past', ago(H + 1));
      expect(staleCount(svc)).toBe(1);
    });

    it('handles ISO, SQLite and offset formats in one table', () => {
      addLease(db, 'iso-old', '2026-10-23T10:00:00.000Z');
      addLease(db, 'sqlite-old', '2026-10-23 10:00:00');
      addLease(db, 'offset-old', '2026-10-23T12:30:00+02:00'); // = 10:30Z
      addLease(db, 'iso-new', '2026-10-23T11:30:00.000Z');
      addLease(db, 'sqlite-new', '2026-10-23 11:30:00');
      addLease(db, 'offset-new', '2026-10-23T13:30:00+02:00'); // = 11:30Z
      addLease(db, 'prev-day-iso', '2026-10-22T23:59:00.000Z');
      expect(staleCount(svc)).toBe(4);
    });

    it('does not count NULL or unparseable updated_at, nor terminal leases', () => {
      addLease(db, 'null', null);
      addLease(db, 'junk', 'not-a-date');
      addLease(db, 'done', ago(5 * H), { status: 'completed' });
      expect(staleCount(svc)).toBe(0);
    });
  });

  describe('24 h loop-run window', () => {
    it('excludes an ISO run from earlier on the cutoff day and includes one inside the window', () => {
      const ins = db.prepare("INSERT INTO loop_runs (id, loop_name, status, created_at) VALUES (?, 'l', 'completed', ?)");
      ins.run('old-iso', ago(28 * H)); // 2026-10-22T08:00Z — the cutoff is 2026-10-22 12:00
      ins.run('in-iso', ago(20 * H));
      ins.run('in-sqlite', '2026-10-22 13:00:00');
      ins.run('old-sqlite', '2026-10-22 11:00:00');
      ins.run('null', null);
      expect(loopTotal(svc)).toBe(2);
    });
  });

  describe('stale lease repair is never more destructive than before', () => {
    const heal = () => svc.heal().actions.find((a) => a.action === 'cancel_stale_leases');

    it('cancels an abandoned lease of a finished run that the old predicate also cancelled', () => {
      db.prepare("INSERT INTO loop_runs (id, loop_name, status) VALUES ('done-run', 'l', 'completed')").run();
      addLease(db, 'abandoned', ago(48 * H), { run: 'done-run' });
      expect(heal()?.result).toBe('success');
      expect(status(db, 'abandoned')).toBe('cancelled');
      const meta = JSON.parse((db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get('abandoned') as { metadata: string }).metadata);
      expect(meta.cancellation_reason).toBe('self_healing_stale_lease');
    });

    it('does not cancel a same-day ISO lease the old text predicate never matched', () => {
      addLease(db, 'same-day', ago(2 * H));
      expect(staleCount(svc)).toBe(1); // detected...
      heal();
      expect(status(db, 'same-day')).toBe('prepared'); // ...but the repair stays as narrow as it was
    });

    it('does not cancel a prepared lease whose execution-engine task is still active', () => {
      for (const s of ['running', 'pending', 'queued', 'awaiting_approval', 'paused']) {
        db.prepare('INSERT INTO tasks (id, status) VALUES (?, ?)').run(`t-${s}`, s);
        addLease(db, `l-${s}`, ago(48 * H), { metadata: { execution_task_id: `t-${s}` } });
      }
      heal();
      for (const s of ['running', 'pending', 'queued', 'awaiting_approval', 'paused']) expect(status(db, `l-${s}`)).toBe('prepared');
    });

    it('does not cancel a lease bound to a task that is missing', () => {
      addLease(db, 'ghost-task', ago(48 * H), { metadata: { execution_task_id: 'nope' } });
      heal();
      expect(status(db, 'ghost-task')).toBe('prepared');
    });

    it('cancels a lease whose bound task is terminal', () => {
      db.prepare("INSERT INTO tasks (id, status) VALUES ('t-done', 'failed')").run();
      addLease(db, 'l-done', ago(48 * H), { metadata: { execution_task_id: 't-done' } });
      heal();
      expect(status(db, 'l-done')).toBe('cancelled');
    });

    it('does not cancel remote leases, remote gym runs, live in-process leases or leases of active runs', () => {
      db.prepare("INSERT INTO loop_runs (id, loop_name, status) VALUES ('active', 'l', 'running')").run();
      db.prepare("INSERT INTO loop_runs (id, loop_name, status, metadata) VALUES ('gym', 'l', 'completed', ?)").run(JSON.stringify({ gym: { remote_host: 'h1' } }));
      addLease(db, 'remote', ago(48 * H), { runtime: 'remote' });
      addLease(db, 'gym-lease', ago(48 * H), { run: 'gym' });
      addLease(db, 'live', ago(48 * H), { status: 'running' });
      addLease(db, 'active-run', ago(48 * H), { run: 'active' });
      RuntimeLeaseRegistry.register('live');
      heal();
      for (const id of ['remote', 'gym-lease', 'live', 'active-run']) expect(status(db, id)).not.toBe('cancelled');
    });

    it('cancels only a subset of what the old text predicate cancelled, across formats and hours', () => {
      // An abandoned lease (no task, no run) at many ages and in both stored formats.
      const stamps: string[] = [];
      for (let m = -30; m <= 60 * 30; m += 17) {
        const iso = ago(m * 60 * 1000);
        stamps.push(iso, iso.slice(0, 19).replace('T', ' '));
      }
      stamps.forEach((s, i) => addLease(db, `g${i}`, s));
      const ageCutoff = (db.prepare('SELECT julianday(?) AS c').get(ago(H)) as { c: number }).c;
      const before = new Map((db.prepare('SELECT id, julianday(updated_at) AS j FROM worker_leases').all() as { id: string; j: number }[]).map((r) => [r.id, r.j]));
      const legacyCutoff = ago(H).slice(0, 19).replace('T', ' '); // = datetime(NOW, '-1 hour')
      const legacy = new Set((db.prepare("SELECT id FROM worker_leases WHERE status IN ('running','prepared') AND updated_at < ?").all(legacyCutoff) as { id: string }[]).map((r) => r.id));
      heal();
      const cancelled = (db.prepare("SELECT id FROM worker_leases WHERE status = 'cancelled'").all() as { id: string }[]).map((r) => r.id);
      expect(cancelled.length).toBeGreaterThan(0);
      for (const id of cancelled) expect(legacy.has(id)).toBe(true);
      // and nothing younger than the 1 h bound is ever cancelled
      for (const id of cancelled) expect(before.get(id)!).toBeLessThan(ageCutoff);
    });

    it('does not cancel a negative-offset lease younger than 1 h that the old text predicate matched', () => {
      // = 2026-10-23T11:50Z, 10 min old, but its text date ('2026-10-22') sorts before the cutoff '2026-10-23 11:00:00'.
      addLease(db, 'young-prev-date', '2026-10-22T23:50:00-12:00');
      addLease(db, 'old', '2026-10-21T22:00:00.000Z');
      const legacy = db.prepare("SELECT 1 FROM worker_leases WHERE id = 'young-prev-date' AND updated_at < '2026-10-23 11:00:00'").get();
      expect(legacy).toBeTruthy();
      heal();
      expect(status(db, 'young-prev-date')).toBe('prepared');
      expect(status(db, 'old')).toBe('cancelled');
    });
  });
});
