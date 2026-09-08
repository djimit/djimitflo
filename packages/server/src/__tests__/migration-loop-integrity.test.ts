import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../database/migrate';
import { schema } from '../database/schema';

describe('loop evidence migration integrity', () => {
  it('preserves legacy evidence while repairing parents and stale spawn foreign keys', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status) VALUES ('legacy-run', 'old', 'closed', 'completed')").run();
    db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status) VALUES ('legacy-lease', 'legacy-run', 'maker', 'mock', 'completed')").run();
    db.prepare(`INSERT INTO sub_agent_spawns
      (id, spawn_tree_id, requested_by_lease_id, depth, runtime, requested_role, prompt_digest, status)
      VALUES ('legacy-spawn', 'legacy-tree', 'legacy-lease', 0, 'mock', 'maker', 'sha256:test', 'completed')`).run();

    db.pragma('foreign_keys = OFF');
    db.exec(`
      DELETE FROM loop_runs WHERE id = 'legacy-run';
      ALTER TABLE sub_agent_spawns RENAME TO current_spawns;
      CREATE TABLE sub_agent_spawns (
        id TEXT PRIMARY KEY, spawn_tree_id TEXT NOT NULL, parent_lease_id TEXT, child_lease_id TEXT,
        requested_by_lease_id TEXT NOT NULL, depth INTEGER NOT NULL, runtime TEXT NOT NULL,
        requested_role TEXT NOT NULL, prompt_digest TEXT NOT NULL, status TEXT NOT NULL,
        reject_reason TEXT, token_budget_grant INTEGER, wall_budget_ms INTEGER, created_at TEXT NOT NULL,
        FOREIGN KEY (requested_by_lease_id) REFERENCES worker_leases_old(id)
      );
      INSERT INTO sub_agent_spawns SELECT * FROM current_spawns;
      DROP TABLE current_spawns;
    `);
    db.pragma('foreign_keys = ON');
    expect(db.pragma('foreign_key_check').length).toBeGreaterThan(0);

    runMigrations(db);

    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.prepare("SELECT status, metadata FROM loop_runs WHERE id = 'legacy-run'").get()).toMatchObject({
      status: 'interrupted',
      metadata: expect.stringContaining('UNDETERMINED'),
    });
    expect(db.prepare("SELECT id FROM sub_agent_spawns WHERE id = 'legacy-spawn'").get()).toEqual({ id: 'legacy-spawn' });
    expect(new Set((db.pragma('foreign_key_list(sub_agent_spawns)') as Array<{ table: string }>).map((row) => row.table)))
      .toEqual(new Set(['worker_leases']));
    db.close();
  });
});
