import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ensureDatabaseInstanceId, getDatabaseProvenance } from '../database/provenance';

describe('database provenance', () => {
  it('creates one stable database identity', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');

    const first = ensureDatabaseInstanceId(db);
    expect(ensureDatabaseInstanceId(db)).toBe(first);
    expect(getDatabaseProvenance(db).instance_id).toBe(first);
    db.close();
  });
});
