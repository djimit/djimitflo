import { beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { runAce001 } from '../services/maker-genome';
import type { AceContext } from '../services/ace-001';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); });

const ctx = (run: string, metadata: Record<string, unknown>, createdAt?: string) =>
  db.prepare(`INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at)
    VALUES (?, ?, 'assignment_context', 'info', 'x', ?, ?)`).run(`ev-${run}-${Math.random()}`, run, JSON.stringify(metadata), createdAt ?? "datetime('now')");

const ACE: AceContext = { arm: '10', lane: 'test-gap', examples_source: 'similarity', kb_paths: ['docs/x.md'], fallback: [] };

it('runAce001: returns the ace_001 context from the latest assignment_context event', () => {
  ctx('run-1', { ace_001: ACE });
  expect(runAce001(db, 'run-1')).toEqual(ACE);
});

it('runAce001: picks the newest assignment_context event when multiple exist', () => {
  ctx('run-2', { ace_001: { ...ACE, arm: '00' } }, '2026-01-01T00:00:00Z');
  ctx('run-2', { ace_001: { ...ACE, arm: '11' } }, '2026-01-02T00:00:00Z');
  expect(runAce001(db, 'run-2')?.arm).toBe('11');
});

it('runAce001: returns null when no assignment_context event exists for the run', () => {
  ctx('run-3', { ace_001: ACE });
  expect(runAce001(db, 'run-no-events')).toBeNull();
});

it('runAce001: returns null when the event metadata has no ace_001 field', () => {
  ctx('run-4', { examples: ['a.test.ts'], rule_ids: ['r1'] });
  expect(runAce001(db, 'run-4')).toBeNull();
});

it('runAce001: returns null when ace_001.arm is not a string (malformed)', () => {
  ctx('run-5', { ace_001: { arm: 42, lane: 'test-gap', examples_source: 'recency', kb_paths: [], fallback: [] } });
  expect(runAce001(db, 'run-5')).toBeNull();
});

it('runAce001: returns null when the loop_events table is absent (catch path)', () => {
  const broken = { prepare: () => { throw new Error('no such table: loop_events'); } } as unknown as Database.Database;
  expect(runAce001(broken, 'run-6')).toBeNull();
});