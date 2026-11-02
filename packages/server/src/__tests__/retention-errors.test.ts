/**
 * Forensic audit 2026-10-26 OBS-003: a purge error is never reported as a green zero.
 * A missing table is a known no-op; any other DB error is a per-table error, the run is not 'ok', and the scheduler
 * registry shows it as failing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { RetentionService } from '../services/retention-service';
import { listSchedulers } from '../services/scheduler-registry';

const retentionScheduler = () => listSchedulers().schedulers.find((s) => s.name === 'retention');

describe('RetentionService error reporting (OBS-003)', () => {
  const services: RetentionService[] = [];
  afterEach(() => { for (const s of services.splice(0)) s.stop(); });

  it('reports a DB error per table instead of zero deleted', async () => {
    const failing = { prepare() { throw new Error('SQLITE_BUSY: database is locked'); } } as any;
    const retention = new RetentionService(failing);
    const result = await retention.purge();
    expect(result.status).toBe('error');
    expect(result.results).toHaveLength(8);
    for (const r of result.results) {
      expect(r.status).toBe('error');
      expect(r.deleted).toBeNull();
      expect(r.error).toContain('database is locked');
    }
    expect(retention.getStats().lastStatus).toBe('error');
    expect(retention.getStats().lastErrors).toHaveLength(8);
  });

  it('distinguishes a missing table (known no-op) from a real error and a real zero', async () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE cognitive_episodes (id TEXT PRIMARY KEY, recorded_at TEXT NOT NULL)`);
    db.exec(`CREATE TABLE trajectory_steps (id TEXT PRIMARY KEY)`); // wrong schema: no created_at column
    const result = await new RetentionService(db).purge();
    const byTable = Object.fromEntries(result.results.map((r) => [r.table, r]));
    expect(byTable.cognitive_episodes).toMatchObject({ status: 'ok', deleted: 0 });
    expect(byTable.experience_embeddings).toMatchObject({ status: 'missing', deleted: 0 });
    expect(byTable.trajectory_steps.status).toBe('error');
    expect(byTable.trajectory_steps.error).toMatch(/no such column/);
    expect(result.status).toBe('error');
    db.close();
  });

  it('a clean run is ok with known zeros', async () => {
    const db = new Database(':memory:');
    const result = await new RetentionService(db).purge();
    expect(result.status).toBe('ok');
    expect(result.results.every((r) => r.status === 'missing' && r.deleted === 0)).toBe(true);
    db.close();
  });

  it('a failing scheduled purge shows as failing in the scheduler registry', async () => {
    const failing = { prepare() { throw new Error('disk I/O error'); } } as any;
    const retention = new RetentionService(failing);
    services.push(retention);
    retention.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(retentionScheduler()).toMatchObject({ armed: true, status: 'failing' });
    expect(retentionScheduler()!.last_error).toContain('disk I/O error');
  });
});
