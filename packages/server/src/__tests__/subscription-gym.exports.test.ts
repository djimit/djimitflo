import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { subscriptionAttemptsToday } from '../services/subscription-gym';

const makeDb = () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE loop_runs (
    id TEXT PRIMARY KEY,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`);
  return db;
};

const insertRun = (db: Database, id: string, species: string, subscription: number, createdAt: string) => {
  const metadata = JSON.stringify({ gym: { species, subscription } });
  db.prepare(`INSERT INTO loop_runs (id, metadata, created_at) VALUES (?, ?, ?)`).run(id, metadata, createdAt);
};

it('returns 0 when no matching rows exist', () => {
  const db = makeDb();
  expect(subscriptionAttemptsToday(db, 'claude')).toBe(0);
});

it('counts only rows within the 24 h window for the given species key', () => {
  const db = makeDb();
  const now = Date.parse('2026-10-18T12:00:00Z');
  // inside window (3 h before now)
  insertRun(db, 'r1', 'claude', 1, new Date(now - 3 * 3_600_000).toISOString());
  // outside window (30 h before now)
  insertRun(db, 'r2', 'claude', 1, new Date(now - 30 * 3_600_000).toISOString());
  expect(subscriptionAttemptsToday(db, 'claude', now)).toBe(1);
});

it('excludes rows where gym.subscription is not 1', () => {
  const db = makeDb();
  const now = Date.parse('2026-10-18T12:00:00Z');
  insertRun(db, 'r1', 'codex', 1, new Date(now - 1_000).toISOString());
  insertRun(db, 'r2', 'codex', 0, new Date(now - 2_000).toISOString());
  expect(subscriptionAttemptsToday(db, 'codex', now)).toBe(1);
});

it('excludes rows with a different species key', () => {
  const db = makeDb();
  const now = Date.parse('2026-10-18T12:00:00Z');
  insertRun(db, 'r1', 'claude', 1, new Date(now - 1_000).toISOString());
  insertRun(db, 'r2', 'opencode@opencode/deepseek-v4.1-flash-free', 1, new Date(now - 2_000).toISOString());
  expect(subscriptionAttemptsToday(db, 'claude', now)).toBe(1);
  expect(subscriptionAttemptsToday(db, 'opencode@opencode/deepseek-v4.1-flash-free', now)).toBe(1);
});

it('respects the custom now parameter for window boundaries', () => {
  const db = makeDb();
  // row created at 2026-10-17T00:00:00Z
  insertRun(db, 'r1', 'claude', 1, '2026-10-17T00:00:00.000Z');
  // now = 2026-10-17T12:00:00Z → window starts 2026-10-16T12:00:00Z → row is inside
  expect(subscriptionAttemptsToday(db, 'claude', Date.parse('2026-10-17T12:00:00Z'))).toBe(1);
  // now = 2026-10-18T12:00:00Z → window starts 2026-10-17T12:00:00Z → row is outside
  expect(subscriptionAttemptsToday(db, 'claude', Date.parse('2026-10-18T12:00:00Z'))).toBe(0);
});
