import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { BackgroundWorkerService } from '../services/background-worker-service';

/**
 * C-reliability 30-10 §1d: the orphan lease cleanup compared ISO `…T…Z` lease timestamps with SQLite's
 * `datetime('now', '-N hours')` text (`YYYY-MM-DD HH:MM:SS`). 'T' sorts after ' ', so a lease only matched once it was
 * from an earlier UTC date than the threshold: every stale_timeout cancel in 7 d happened at 00:02–00:13Z, on leases
 * 24–48 h old. Both thresholds now compare ISO with ISO.
 */
const H = 3_600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const dbs: Database.Database[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); vi.unstubAllEnvs(); });

function seed() {
  const db = new Database(':memory:');
  db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF');
  dbs.push(db);
  db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status) VALUES ('r', 'doc-drift-and-small-fix-loop', 'closed', 'blocked')").run();
  const lease = db.prepare('INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, \'r\', ?, ?, ?, \'{}\', ?, ?)');
  lease.run('prepared-25h', 'checker', 'manual', 'prepared', iso(25 * H), iso(25 * H));
  lease.run('prepared-23h', 'checker', 'manual', 'prepared', iso(23 * H), iso(23 * H));
  lease.run('running-3h', 'maker', 'opencode', 'running', iso(3 * H), iso(3 * H));
  lease.run('running-1h', 'maker', 'opencode', 'running', iso(1 * H), iso(1 * H));
  return db;
}
const row = (db: Database.Database, id: string) => {
  const r = db.prepare('SELECT status, metadata FROM worker_leases WHERE id = ?').get(id) as { status: string; metadata: string };
  return { status: r.status, metadata: JSON.parse(r.metadata) as Record<string, any> };
};

describe('orphan lease cleanup: ISO thresholds, not datetime() text', () => {
  it('cancels a prepared lease older than 24 h and fails a running lease idle for over 2 h, the same UTC day', async () => {
    const db = seed();
    const result = await new BackgroundWorkerService(db).runWorker('orphan-lease-cleanup');
    expect(result.output).toBe('Cleaned: 1 stale prepared, 1 hung running leases');
    expect(row(db, 'prepared-25h')).toMatchObject({ status: 'cancelled', metadata: { cancellation_reason: 'stale_timeout' } });
    expect(row(db, 'running-3h')).toMatchObject({ status: 'failed', metadata: { failure_reason: 'stale_timeout' } });
  });

  it('leaves a prepared lease younger than 24 h and a running lease active within 2 h alone', async () => {
    const db = seed();
    await new BackgroundWorkerService(db).runWorker('orphan-lease-cleanup');
    expect(row(db, 'prepared-23h').status).toBe('prepared');
    expect(row(db, 'running-1h').status).toBe('running');
  });

  it('still honours the configured thresholds', async () => {
    vi.stubEnv('DJIMFLO_STALE_PREPARED_THRESHOLD_HOURS', '22');
    vi.stubEnv('DJIMFLO_STALE_RUNNING_THRESHOLD_HOURS', '4');
    const db = seed();
    await new BackgroundWorkerService(db).runWorker('orphan-lease-cleanup');
    expect(row(db, 'prepared-23h').status).toBe('cancelled');
    expect(row(db, 'running-3h').status).toBe('running');
  });
});
