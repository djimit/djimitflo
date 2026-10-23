import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ensureLaneTables, reenableDependencyLane } from '../services/dependency-lane';

const freshDb = () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  return db;
};

const stateRow = (db: Database) =>
  db.prepare('SELECT revoked_at, revoked_reason, reenabled_at, reenabled_by FROM dependency_lane_state WHERE id = 1').get() as Record<string, unknown> | undefined;

describe('ensureLaneTables', () => {
  it('creates the lane tables and seeds a single state row', () => {
    const db = freshDb();
    // drop to prove the function recreates them
    db.exec('DROP TABLE IF EXISTS dependency_lane_prs; DROP TABLE IF EXISTS dependency_lane_state;');
    const gone = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('dependency_lane_prs','dependency_lane_state')").all() as Array<{name:string}>);
    expect(gone.length).toBe(0);

    ensureLaneTables(db);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('dependency_lane_prs','dependency_lane_state')").all().map((r) => r.name).sort();
    expect(tables).toEqual(['dependency_lane_prs', 'dependency_lane_state']);
    const s = stateRow(db)!;
    expect(s.revoked_at).toBeNull();
    expect(s.reenabled_at).toBeNull();
  });

  it('is idempotent — running twice keeps exactly one state row', () => {
    const db = freshDb();
    ensureLaneTables(db);
    ensureLaneTables(db);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM dependency_lane_state').get() as { n: number }).n;
    expect(n).toBe(1);
  });
});

describe('reenableDependencyLane', () => {
  it('is a no-op when nothing was revoked', () => {
    const db = freshDb();
    ensureLaneTables(db);
    const res = reenableDependencyLane(db, 'op@example.com', 'no revocation here');
    expect(res.changed).toBe(false);
    expect(stateRow(db)!.revoked_at).toBeNull();
  });

  it('clears the revocation and records who/when re-enabled act mode', () => {
    const db = freshDb();
    ensureLaneTables(db);
    // simulate an earlier revocation
    db.prepare("UPDATE dependency_lane_state SET revoked_at = ?, revoked_reason = ? WHERE id = 1")
      .run('2026-10-07T08:00:00.000Z', 'main CI red on abc123 after merging #42');
    expect(stateRow(db)!.revoked_at).not.toBeNull();

    const now = new Date('2026-10-08T10:00:00Z');
    const res = reenableDependencyLane(db, 'operator@djimitflo.dev', 'CI green again', now);
    expect(res.changed).toBe(true);

    const s = stateRow(db)!;
    expect(s.revoked_at).toBeNull();
    expect(s.revoked_reason).toBeNull();
    expect(s.reenabled_at).toBe(now.toISOString());
    expect(s.reenabled_by).toBe('operator@djimitflo.dev');
  });

  it('is a no-op once already re-enabled (nothing left to clear)', () => {
    const db = freshDb();
    ensureLaneTables(db);
    db.prepare("UPDATE dependency_lane_state SET revoked_at = ?, revoked_reason = ? WHERE id = 1")
      .run('2026-10-07T08:00:00.000Z', 'red base');
    expect(reenableDependencyLane(db, 'a', 'first').changed).toBe(true);
    // second call: revoked_at is null again -> changed false
    expect(reenableDependencyLane(db, 'b', 'second').changed).toBe(false);
  });
});
