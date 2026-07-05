import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from './helpers/test-db';

import { GoalBatchService } from '../services/goal-batch-service';

function makeDb() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(schema);
  runMigrations(database);
  return database;
}

function counts(db: Database.Database) {
  return {
    goals: (db.prepare('SELECT COUNT(*) as count FROM goals').get() as any).count,
    work_items: (db.prepare('SELECT COUNT(*) as count FROM work_items').get() as any).count,
    loop_runs: (db.prepare('SELECT COUNT(*) as count FROM loop_runs').get() as any).count,
    worker_leases: (db.prepare('SELECT COUNT(*) as count FROM worker_leases').get() as any).count,
  };
}

describe('goal batch service', () => {
  it('previews goals.batch.json shape with zero writes and applies planning records only', () => {
    const db = makeDb();
    try {
      const service = new GoalBatchService(db);
      const batch = {
        change: 'test-change',
        goals: [
          {
            id: 'goal-1',
            title: 'Prove goal batch preview',
            risk: 'medium',
            target: 'packages/server',
            acceptance: ['Preview creates no writes'],
          },
        ],
      };

      const beforePreview = counts(db);
      const preview = service.preview({ batch });
      expect(preview).toMatchObject({
        change: 'test-change',
        total: 1,
        valid: 1,
        blocked: 0,
        writes: 0,
      });
      expect(counts(db)).toEqual(beforePreview);

      const applied = service.apply({ batch });
      expect(applied.created_goals).toHaveLength(1);
      expect(applied.started_workers).toBe(0);
      expect(counts(db)).toMatchObject({
        goals: 1,
        work_items: 0,
        loop_runs: 0,
        worker_leases: 0,
      });
    } finally {
      db.close();
    }
  });

  it('rejects malformed batches without partial import', () => {
    const db = makeDb();
    try {
      const service = new GoalBatchService(db);
      const batch = {
        change: 'bad-change',
        goals: [{ id: 'bad-goal', risk: 'medium', acceptance: [] }],
      };
      expect(() => service.apply({ batch })).toThrow('GOAL_BATCH_INVALID');
      expect(counts(db)).toEqual({
        goals: 0,
        work_items: 0,
        loop_runs: 0,
        worker_leases: 0,
      });
    } finally {
      db.close();
    }
  });
});
