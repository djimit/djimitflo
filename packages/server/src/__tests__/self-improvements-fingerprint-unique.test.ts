import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrate';
import { schema } from '../database/schema';

describe('P1c: self_improvements fingerprint UNIQUE', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); db.exec(schema); });
  afterEach(() => db.close());

  it('creates unique index; re- migration is idempotent', () => {
    runMigrations(db);
    const idx = db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_self_improve_fingerprint_unique'"
    ).get() as { name: string; sql: string } | undefined;
    expect(idx).toBeDefined();
    expect(idx!.sql).toMatch(/UNIQUE/i);
    // second migration pass must not throw
    expect(() => runMigrations(db)).not.toThrow();
  });

  it('dedupes pre-existing duplicate fingerprints keeping newest ROWID', () => {
    // seed via bare INSERT before migration-driven unique index exists? Index already runs in first migration.
    // Simulate: drop unique index, insert two dupes, rerun migration → dedupe applied.
    runMigrations(db);
    db.exec('DROP INDEX IF EXISTS idx_self_improve_fingerprint_unique');
    const insert = db.prepare(
      "INSERT INTO self_improvements (id, type, title, description, rationale, source, fingerprint, created_at) VALUES (?, 't', 't', 'd', 'r', 's', ?, ?)"
    );
    insert.run('a', 'fp1', '2026-01-01');
    insert.run('b', 'fp1', '2026-01-02');
    insert.run('c', 'fp2', '2026-01-01');
    insert.run('d', null,   '2026-01-01');
    // force re-run of the dedupe+index block by calling runMigrations again
    runMigrations(db);
    const rows = db.prepare("SELECT id FROM self_improvements WHERE fingerprint='fp1'").all() as { id: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe('b'); // newest ROWID kept
    const nullRows = db.prepare("SELECT id FROM self_improvements WHERE fingerprint IS NULL").all();
    expect(nullRows.length).toBe(1); // NULLs untouched
  });

  it('rejects duplicate non-null fingerprint insert after migration', () => {
    runMigrations(db);
    db.prepare("INSERT INTO self_improvements (id, type, title, description, rationale, source, fingerprint) VALUES ('x', 't', 't', 'd', 'r', 's', 'fpX')").run();
    expect(() =>
      db.prepare("INSERT INTO self_improvements (id, type, title, description, rationale, source, fingerprint) VALUES ('y', 't', 't', 'd', 'r', 's', 'fpX')").run()
    ).toThrow(/UNIQUE/);
  });
});
