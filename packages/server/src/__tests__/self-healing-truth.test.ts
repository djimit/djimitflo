/**
 * Dashboard truth audit 12-11 (prod, SELF_HEALING_SCHEDULER_ENABLED=true):
 *  - heal() cancelled leases with real DB writes while its own log is in-memory only → each cancellation is audited;
 *  - loop_failure_rate read 0/49 "healthy" while every product-loop run was blocked → blocked runs count;
 *  - advisory no-ops (analyze/flag/recommend) were reported as a successful fix → they are 'advisory', not resolved.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SelfHealingService } from '../services/self-healing-service';
import { RuntimeLeaseRegistry } from '../services/loop-recovery-service';

const NOW = new Date('2026-11-12T12:00:00.000Z');
const H = 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe('self-healing truth (12-11)', () => {
  let db: Database.Database;
  let svc: SelfHealingService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE loop_runs (id TEXT PRIMARY KEY, loop_name TEXT, status TEXT DEFAULT 'created', metadata TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE worker_leases (id TEXT PRIMARY KEY, loop_run_id TEXT, role TEXT, runtime TEXT DEFAULT 'codex',
        status TEXT DEFAULT 'prepared', metadata TEXT DEFAULT '{}', created_at TEXT, updated_at TEXT);
    `);
    svc = new SelfHealingService(db, () => NOW);
  });
  afterEach(() => RuntimeLeaseRegistry.clear());

  it('counts blocked runs in loop_failure_rate', () => {
    const ins = db.prepare("INSERT INTO loop_runs (id, loop_name, status, created_at) VALUES (?, 'product', ?, ?)");
    for (let i = 0; i < 4; i++) ins.run(`b${i}`, 'blocked', ago(H));
    ins.run('ok', 'completed', ago(H));
    const check = svc.checkHealth().find((c) => c.name === 'loop_failure_rate')!;
    expect(check.status).toBe('critical');
    expect(check.message).toBe('80% failed or blocked (0 failed + 4 blocked = 4/5)');
  });

  it('writes one audit event per cancelled lease, as system:self-healing', () => {
    db.prepare("INSERT INTO loop_runs (id, loop_name, status, created_at) VALUES ('done', 'l', 'completed', ?)").run(ago(72 * H));
    const lease = db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, status, created_at, updated_at) VALUES (?, ?, 'maker', 'prepared', ?, ?)");
    lease.run('abandoned-1', 'done', ago(48 * H), ago(48 * H));
    lease.run('abandoned-2', 'done', ago(48 * H), ago(48 * H));
    lease.run('fresh', 'done', ago(H / 4), ago(H / 4));

    const action = svc.heal().actions.find((a) => a.action === 'cancel_stale_leases')!;
    expect(action.result).toBe('success');
    const events = db.prepare("SELECT user_id, action, resource_type, resource_id, before, after FROM audit_events WHERE resource_type = 'worker_lease' ORDER BY resource_id").all() as any[];
    expect(events.map((e) => e.resource_id)).toEqual(['abandoned-1', 'abandoned-2']);
    for (const e of events) {
      expect(e).toMatchObject({ user_id: 'system:self-healing', action: 'self_healing.cancel_stale_lease' });
      expect(JSON.parse(e.before)).toEqual({ status: 'prepared' });
      expect(JSON.parse(e.after)).toEqual({ status: 'cancelled' });
    }
    expect((db.prepare("SELECT status FROM worker_leases WHERE id = 'fresh'").get() as any).status).toBe('prepared');
  });

  it('marks advisory no-ops as advisory and leaves their incident unresolved', () => {
    db.prepare("INSERT INTO loop_runs (id, loop_name, status, created_at) VALUES ('f1', 'l', 'failed', ?)").run(ago(H));
    const { incidents, actions } = svc.heal();
    const analyze = actions.find((a) => a.action === 'analyze_failures')!;
    expect(analyze.result).toBe('advisory');
    const incident = incidents.find((i) => i.id === analyze.incidentId)!;
    expect(incident.autoFixSucceeded).toBe(false);
    expect(incident.resolvedAt).toBeUndefined();
  });
});
