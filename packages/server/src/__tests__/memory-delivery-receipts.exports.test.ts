import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import {
  ensureReceiptsTable,
  claimInitial,
  claimRetry,
  recordOutcome,
} from '../services/memory-delivery-receipts';
import { createTestDb } from './helpers/test-db';

describe('memory-delivery-receipts exports (ensureReceiptsTable, claimInitial, claimRetry)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('ensureReceiptsTable', () => {
    it('creates the memory_sync_receipts table when absent', () => {
      ensureReceiptsTable(db);
      const names = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_sync_receipts'",
      ).all() as { name: string }[];
      expect(names).toHaveLength(1);
      expect(names[0].name).toBe('memory_sync_receipts');
    });

    it('is idempotent — calling twice does not error or duplicate', () => {
      ensureReceiptsTable(db);
      expect(() => ensureReceiptsTable(db)).not.toThrow();
      const names = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_sync_receipts'",
      ).all() as { name: string }[];
      expect(names).toHaveLength(1);
    });

    it('enforces the status CHECK constraint (rejects an invalid status)', () => {
      ensureReceiptsTable(db);
      expect(() =>
        db.prepare(
          "INSERT INTO memory_sync_receipts (task_id, target, status, detail, attempts, updated_at) VALUES ('t','qdrant','bogus',NULL,1,'2026-01-01T00:00:00.000Z')",
        ).run(),
      ).toThrow();
    });
  });

  describe('claimInitial', () => {
    beforeEach(() => {
      ensureReceiptsTable(db);
    });

    it('inserts an unknown receipt with attempts=1 and returns true on the first claim', () => {
      const now = 1_700_000_000_000;
      expect(claimInitial(db, 'task-1', 'qdrant', 'in_flight', now)).toBe(true);
      const row = db.prepare(
        'SELECT task_id, target, status, detail, attempts, updated_at FROM memory_sync_receipts',
      ).get() as Record<string, unknown>;
      expect(row.task_id).toBe('task-1');
      expect(row.target).toBe('qdrant');
      expect(row.status).toBe('unknown');
      expect(row.detail).toBe('in_flight');
      expect(row.attempts).toBe(1);
      expect(row.updated_at).toBe(new Date(now).toISOString());
    });

    it('returns false on a repeated claim for the same task+target (no duplicate)', () => {
      expect(claimInitial(db, 'task-2', 'okf')).toBe(true);
      expect(claimInitial(db, 'task-2', 'okf')).toBe(false);
      const count = (
        db.prepare('SELECT COUNT(*) AS n FROM memory_sync_receipts').get() as { n: number }
      ).n;
      expect(count).toBe(1);
    });

    it('defaults detail to "in_flight" when omitted', () => {
      claimInitial(db, 'task-3', 'uams');
      const row = db.prepare(
        'SELECT detail FROM memory_sync_receipts WHERE task_id = ? AND target = ?',
      ).get('task-3', 'uams') as { detail: string };
      expect(row.detail).toBe('in_flight');
    });

    it('allows the same task_id across different targets (one row per target)', () => {
      expect(claimInitial(db, 'task-4', 'qdrant')).toBe(true);
      expect(claimInitial(db, 'task-4', 'okf')).toBe(true);
      expect(claimInitial(db, 'task-4', 'uams')).toBe(true);
      const count = (
        db.prepare('SELECT COUNT(*) AS n FROM memory_sync_receipts WHERE task_id = ?').get('task-4') as { n: number }
      ).n;
      expect(count).toBe(3);
    });
  });

  describe('claimRetry', () => {
    beforeEach(() => {
      ensureReceiptsTable(db);
    });

    it('wins only when status and attempts match the row, incrementing attempts and resetting status to unknown', () => {
      const now = 1_700_000_000_000;
      claimInitial(db, 'task-r1', 'qdrant', 'in_flight', now);
      recordOutcome(db, 'task-r1', 'qdrant', { status: 'failed', detail: '4xx' }, now + 1000);
      const before = db.prepare(
        'SELECT status, attempts, detail FROM memory_sync_receipts WHERE task_id = ? AND target = ?',
      ).get('task-r1', 'qdrant') as { status: string; attempts: number; detail: string };
      expect(before.status).toBe('failed');
      expect(before.attempts).toBe(1);

      const retryAt = now + 5000;
      expect(claimRetry(db, { task_id: 'task-r1', target: 'qdrant', status: 'failed', attempts: 1 }, 'retry', retryAt)).toBe(true);

      const after = db.prepare(
        'SELECT status, attempts, detail, updated_at FROM memory_sync_receipts WHERE task_id = ? AND target = ?',
      ).get('task-r1', 'qdrant') as { status: string; attempts: number; detail: string; updated_at: string };
      expect(after.status).toBe('unknown');
      expect(after.attempts).toBe(2);
      expect(after.detail).toBe('retry');
      expect(after.updated_at).toBe(new Date(retryAt).toISOString());
    });

    it('returns false when the stored status no longer matches (compare-and-set guard)', () => {
      const now = 1_700_000_000_000;
      claimInitial(db, 'task-r2', 'okf', 'in_flight', now);
      recordOutcome(db, 'task-r2', 'okf', { status: 'delivered', detail: 'ok' }, now + 1000);
      // Pass a stale failed state — the row is actually delivered.
      expect(
        claimRetry(db, { task_id: 'task-r2', target: 'okf', status: 'failed', attempts: 1 }, 'retry', now + 2000),
      ).toBe(false);
      const row = db.prepare(
        'SELECT status, attempts FROM memory_sync_receipts WHERE task_id = ? AND target = ?',
      ).get('task-r2', 'okf') as { status: string; attempts: number };
      expect(row.status).toBe('delivered');
      expect(row.attempts).toBe(1);
    });

    it('returns false when the stored attempts no longer match (compare-and-set guard)', () => {
      const now = 1_700_000_000_000;
      claimInitial(db, 'task-r3', 'qdrant', 'in_flight', now);
      recordOutcome(db, 'task-r3', 'qdrant', { status: 'failed', detail: '4xx' }, now + 1000);
      // Stale attempts count (claims 0, row is 1).
      expect(
        claimRetry(db, { task_id: 'task-r3', target: 'qdrant', status: 'failed', attempts: 0 }, 'retry', now + 2000),
      ).toBe(false);
      const row = db.prepare(
        'SELECT attempts FROM memory_sync_receipts WHERE task_id = ? AND target = ?',
      ).get('task-r3', 'qdrant') as { attempts: number };
      expect(row.attempts).toBe(1);
    });

    it('returns false when no receipt row exists for the task+target', () => {
      expect(
        claimRetry(db, { task_id: 'nope', target: 'qdrant', status: 'failed', attempts: 1 }, 'retry'),
      ).toBe(false);
    });

    it('defaults detail to "in_flight" when omitted', () => {
      const now = 1_700_000_000_000;
      claimInitial(db, 'task-r4', 'okf', 'in_flight', now);
      recordOutcome(db, 'task-r4', 'okf', { status: 'failed', detail: '4xx' }, now + 1000);
      claimRetry(db, { task_id: 'task-r4', target: 'okf', status: 'failed', attempts: 1 }, undefined, now + 2000);
      const row = db.prepare(
        'SELECT detail FROM memory_sync_receipts WHERE task_id = ? AND target = ?',
      ).get('task-r4', 'okf') as { detail: string };
      expect(row.detail).toBe('in_flight');
    });
  });
});