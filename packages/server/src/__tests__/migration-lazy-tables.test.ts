import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

describe('lazy service tables are available after normal startup migrations', () => {
  it('creates context cache and upgrades legacy consensus columns', () => {
    const db = new Database(':memory:');
    db.exec(schema);
    db.exec(`CREATE TABLE consensus_debates (
      id TEXT PRIMARY KEY, topic TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), resolved_at TEXT
    )`);

    runMigrations(db);

    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'context_cache'").get()).toBeTruthy();
    const columns = db.prepare('PRAGMA table_info(consensus_debates)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(['context', 'winning_proposal_id', 'consensus_score']));
    db.close();
  });
});
