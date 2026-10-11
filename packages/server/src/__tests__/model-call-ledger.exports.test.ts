import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { experimentArms } from '../services/model-call-ledger';

let db: Database.Database;

afterEach(() => {
  db?.close();
});

const fresh = () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  return db;
};

describe('experimentArms', () => {
  it('returns null when no arms are provided', () => {
    fresh();
    expect(experimentArms(db, null, null, null)).toBeNull();
  });

  it('includes the ACE arm when ace is provided', () => {
    fresh();
    const result = experimentArms(db, null, { arm: '01' }, null);
    expect(result).toBe('ACE-001:01');
  });

  it('includes the STE arm when ste is provided', () => {
    fresh();
    const result = experimentArms(db, null, null, { arm: 2 });
    expect(result).toBe('STE-001:2');
  });

  it('joins ACE and STE arms with a comma in order', () => {
    fresh();
    const result = experimentArms(db, null, { arm: '03' }, { arm: 4 });
    expect(result).toBe('ACE-001:03,STE-001:4');
  });

  it('appends the F2 checker_family_arm from goal metadata', () => {
    fresh();
    db.prepare(
      "INSERT INTO goals (id, objective, risk_class, status, metadata, created_at, updated_at) VALUES ('g1', 'o', 'low', 'running', ?, datetime('now'), datetime('now'))",
    ).run(JSON.stringify({ checker_family_arm: 'cross' }));
    const result = experimentArms(db, 'g1', null, null);
    expect(result).toBe('F2:cross');
  });

  it('includes all three arms when ace, ste, and goal metadata are present', () => {
    fresh();
    db.prepare(
      "INSERT INTO goals (id, objective, risk_class, status, metadata, created_at, updated_at) VALUES ('g2', 'o', 'low', 'running', ?, datetime('now'), datetime('now'))",
    ).run(JSON.stringify({ checker_family_arm: 'baseline' }));
    const result = experimentArms(db, 'g2', { arm: '01' }, { arm: 1 });
    expect(result).toBe('ACE-001:01,STE-001:1,F2:baseline');
  });

  it('returns only ACE/STE arms when the goal has no checker_family_arm in metadata', () => {
    fresh();
    db.prepare(
      "INSERT INTO goals (id, objective, risk_class, status, metadata, created_at, updated_at) VALUES ('g3', 'o', 'low', 'running', '{}', datetime('now'), datetime('now'))",
    ).run();
    const result = experimentArms(db, 'g3', { arm: '05' }, null);
    expect(result).toBe('ACE-001:05');
  });

  it('handles a non-existent goal id gracefully (no F2 arm)', () => {
    fresh();
    const result = experimentArms(db, 'does-not-exist', null, { arm: 7 });
    expect(result).toBe('STE-001:7');
  });

  it('ignores an empty-string checker_family_arm value', () => {
    fresh();
    db.prepare(
      "INSERT INTO goals (id, objective, risk_class, status, metadata, created_at, updated_at) VALUES ('g4', 'o', 'low', 'running', ?, datetime('now'), datetime('now'))",
    ).run(JSON.stringify({ checker_family_arm: '' }));
    const result = experimentArms(db, 'g4', null, null);
    expect(result).toBeNull();
  });
});
