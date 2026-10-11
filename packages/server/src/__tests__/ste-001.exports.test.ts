import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { runSte001 } from '../services/ste-001';

let db: Database.Database;
const now = new Date().toISOString();

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(schema);
  runMigrations(db);
});
afterEach(() => db.close());

it('returns the ste_001 context from the latest assignment_context event', () => {
  const ctx = { arm: 1 as const, template_hash: 'abc123def456' };
  db.prepare(
    "INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (?, ?, 'assignment_context', 'info', 'm', ?, ?)",
  ).run('ev-1', 'run-a', JSON.stringify({ examples: [], ste_001: ctx }), now);

  expect(runSte001(db, 'run-a')).toEqual(ctx);
});

it('prefers the most recent assignment_context when multiple exist', () => {
  const older = { arm: 0 as const, template_hash: 'old-hash' };
  const newer = { arm: 1 as const, template_hash: 'new-hash' };
  db.prepare(
    "INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (?, ?, 'assignment_context', 'info', 'm', ?, ?)",
  ).run('ev-old', 'run-b', JSON.stringify({ ste_001: older }), '2026-01-01T00:00:00.000Z');
  db.prepare(
    "INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (?, ?, 'assignment_context', 'info', 'm', ?, ?)",
  ).run('ev-new', 'run-b', JSON.stringify({ ste_001: newer }), now);

  expect(runSte001(db, 'run-b')).toEqual(newer);
});

it('returns null when no assignment_context event exists for the run', () => {
  expect(runSte001(db, 'no-such-run')).toBeNull();
});

it('returns null when metadata has no ste_001 key', () => {
  db.prepare(
    "INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (?, ?, 'assignment_context', 'info', 'm', ?, ?)",
  ).run('ev-2', 'run-c', JSON.stringify({ examples: [] }), now);

  expect(runSte001(db, 'run-c')).toBeNull();
});

it('returns null when ste_001.arm is not 0 or 1', () => {
  db.prepare(
    "INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (?, ?, 'assignment_context', 'info', 'm', ?, ?)",
  ).run('ev-3', 'run-d', JSON.stringify({ ste_001: { arm: 7, template_hash: 'x' } }), now);

  expect(runSte001(db, 'run-d')).toBeNull();
});

it('returns null when metadata is malformed JSON', () => {
  db.prepare(
    "INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (?, ?, 'assignment_context', 'info', 'm', ?, ?)",
  ).run('ev-4', 'run-e', '{not valid json', now);

  expect(runSte001(db, 'run-e')).toBeNull();
});
