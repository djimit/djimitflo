import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { repairRenamedForeignKeyTargets, runMigrations, runPreSchemaMigrations } from '../database/migrate';
import { explainerSchema, schema } from '../database/schema';

// Boot path of database/index.ts initializeDatabase, on an in-memory DB.
function boot(db = new Database(':memory:')) {
  db.pragma('foreign_keys = ON');
  runPreSchemaMigrations(db);
  db.exec(schema);
  db.exec(explainerSchema);
  runMigrations(db);
  return db;
}

const fkTargets = (db: Database.Database, table: string) =>
  new Set((db.pragma(`foreign_key_list(${table})`) as Array<{ table: string }>).map((r) => r.table));
const dangling = (db: Database.Database) => {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
  return tables.flatMap((t) => [...fkTargets(db, t)].filter((p) => !tables.includes(p)).map((p) => `${t}->${p}`));
};
const ddl = (db: Database.Database) => db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();

// The prod shape: worker_leases rebuilt rename-first. SQLite >= 3.26 rewrites every child's REFERENCES to
// "worker_leases_old" on the RENAME; the DROP then leaves them dangling (prod: swarm_tasks.assigned_lease_id).
function renameFirstRebuild(db: Database.Database) {
  db.pragma('foreign_keys = OFF');
  db.exec('ALTER TABLE worker_leases RENAME TO worker_leases_old');
  const old = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'worker_leases_old'").get() as { sql: string }).sql;
  db.exec(old.replace(/"?worker_leases_old"?/, 'worker_leases'));
  db.exec('INSERT INTO worker_leases SELECT * FROM worker_leases_old; DROP TABLE worker_leases_old;');
  db.pragma('foreign_keys = ON');
}

function seed(db: Database.Database) {
  db.exec(`
    INSERT INTO loop_runs (id, loop_name, mode, status) VALUES ('run-1', 'l', 'closed', 'completed');
    INSERT INTO worker_leases (id, loop_run_id, role, runtime, status) VALUES ('lease-1', 'run-1', 'maker', 'mock', 'completed');
    INSERT INTO swarm_missions (id, title, risk_class, status) VALUES ('m-1', 'mission', 'low', 'observed');
    INSERT INTO swarm_tasks (id, mission_id, title, status, assigned_lease_id) VALUES ('t-1', 'm-1', 'leased', 'planned', 'lease-1');
    INSERT INTO swarm_tasks (id, mission_id, title, status) VALUES ('t-2', 'm-1', 'unleased', 'planned');
    INSERT INTO swarm_decisions (id, mission_id, task_id, decision_type, decision) VALUES ('d-1', 'm-1', 't-1', 'route', 'go');
  `);
}

const insertTask = (db: Database.Database, id: string, lease: string | null) =>
  db.prepare("INSERT INTO swarm_tasks (id, mission_id, title, status, assigned_lease_id) VALUES (?, 'm-1', 'new', 'planned', ?)").run(id, lease);

describe('repairRenamedForeignKeyTargets', () => {
  it('rebuilds swarm_tasks whose FK points at worker_leases_old: inserts work again, rows and children kept', () => {
    const db = boot();
    seed(db);
    renameFirstRebuild(db);
    expect(fkTargets(db, 'swarm_tasks').has('worker_leases_old')).toBe(true);
    expect(() => insertTask(db, 't-x', null)).toThrow(/no such table: main\.worker_leases_old/);

    runMigrations(db); // next boot

    expect(dangling(db)).toEqual([]);
    expect(fkTargets(db, 'swarm_tasks')).toEqual(new Set(['swarm_missions', 'worker_leases', 'swarm_capabilities']));
    expect(db.prepare('SELECT id, assigned_lease_id FROM swarm_tasks ORDER BY id').all()).toEqual([
      { id: 't-1', assigned_lease_id: 'lease-1' }, { id: 't-2', assigned_lease_id: null },
    ]);
    expect(db.prepare("SELECT task_id FROM swarm_decisions WHERE id = 'd-1'").get()).toEqual({ task_id: 't-1' }); // no cascade
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'swarm_tasks' AND sql IS NOT NULL ORDER BY name").all())
      .toEqual(expect.arrayContaining([{ name: 'idx_swarm_tasks_mission_id' }, { name: 'idx_swarm_tasks_status' }]));
    insertTask(db, 't-3', null);
    insertTask(db, 't-4', 'lease-1');
    expect(() => insertTask(db, 't-5', 'no-such-lease')).toThrow(/FOREIGN KEY constraint failed/); // the FK is enforced again
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(repairRenamedForeignKeyTargets(db)).toEqual([]); // idempotent
    db.close();
  });

  it('leaves a healthy database untouched', () => {
    const db = boot();
    seed(db);
    const before = ddl(db);
    expect(repairRenamedForeignKeyTargets(db)).toEqual([]);
    expect(ddl(db)).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM swarm_tasks').get()).toEqual({ n: 2 });
    db.close();
  });

  it('rolls back and keeps the table as it was when a row would violate the repointed FK', () => {
    const db = boot();
    seed(db);
    renameFirstRebuild(db);
    db.pragma('foreign_keys = OFF');
    insertTask(db, 't-orphan', 'lease-gone');
    db.pragma('foreign_keys = ON');
    const before = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'swarm_tasks'").get() as { sql: string }).sql;

    expect(repairRenamedForeignKeyTargets(db)).not.toContain('swarm_tasks');

    expect((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'swarm_tasks'").get() as { sql: string }).sql).toBe(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM swarm_tasks').get()).toEqual({ n: 3 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'swarm_tasks__fk_repair'").get()).toBeUndefined();
    db.close();
  });
});
