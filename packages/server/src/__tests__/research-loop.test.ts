import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';

describe('G39: Research Loop capability boundary', () => {
  let db: Database.Database;
  let loops: LoopService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    try { db.exec('ALTER TABLE worker_leases ADD COLUMN confidence REAL DEFAULT 0.5'); } catch { /* already present */ }
    loops = new LoopService(db);
  });

  afterEach(() => db.close());

  it('rejects research-loop until discovery, execution and epistemic gates are implemented', () => {
    expect(() => loops.startLoop({ loop_name: 'research-loop' as never }))
      .toThrow('LOOP_NAME_UNSUPPORTED');
    expect((db.prepare('SELECT COUNT(*) AS count FROM loop_runs').get() as { count: number }).count).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM worker_leases').get() as { count: number }).count).toBe(0);
  });
});
