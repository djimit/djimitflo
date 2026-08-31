import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { GoalBatchService } from '../services/goal-batch-service';
import { GoalService } from '../services/goal-service';
import { LoopService } from '../services/loop-service';

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
  it('requires acceptance evidence before direct completion', () => {
    const db = makeDb();
    try {
      const service = new GoalService(db);
      const goal = service.createGoal({
        objective: 'Prove completion',
        acceptance_criteria: ['Evidence exists'],
      });
      expect(() => service.updateGoal(goal.id, { status: 'completed' }))
        .toThrow('GOAL_COMPLETION_EVIDENCE_REQUIRED');
      expect(service.updateGoal(goal.id, {
        status: 'completed',
        metadata: {
          completion_source: 'targeted_execution',
          acceptance_evidence: [{ kind: 'test', ref: 'test-1' }],
        },
      }).status).toBe('completed');
    } finally {
      db.close();
    }
  });

  it('persists ordered dependencies and fails closed until predecessor evidence exists', () => {
    const db = makeDb();
    try {
      const batch = {
        goals: [
          { id: 'DAPS-01', title: 'Provenance', acceptance: ['Accepted'] },
          { id: 'DAPS-02', title: 'Enforcement', acceptance: ['Accepted'], depends_on: ['DAPS-01'] },
        ],
      };
      const applied = new GoalBatchService(db).apply({ batch });
      const first = applied.created_goals.find((goal) => goal.metadata.goal_batch && (goal.metadata.goal_batch as any).id === 'DAPS-01')!;
      const second = applied.created_goals.find((goal) => goal.metadata.goal_batch && (goal.metadata.goal_batch as any).id === 'DAPS-02')!;
      const goals = new GoalService(db);

      expect(second.metadata.depends_on_goal_keys).toEqual(['DAPS-01']);
      expect(() => goals.updateGoal(second.id, { status: 'running', metadata: { depends_on_goal_keys: [] } }))
        .toThrow('GOAL_DEPENDENCY_UNSATISFIED:DAPS-01');
      expect(() => goals.updateGoal(second.id, { status: 'running' })).toThrow('GOAL_DEPENDENCY_UNSATISFIED:DAPS-01');
      expect(() => new LoopService(db).startLoop({ goal_id: second.id, repository_path: process.cwd() }))
        .toThrow('GOAL_DEPENDENCY_UNSATISFIED:DAPS-01');
      expect(counts(db).loop_runs).toBe(0);
      goals.updateGoal(first.id, { status: 'completed', metadata: { acceptance_evidence: [{ ref: 'review-1' }] } });
      expect(goals.updateGoal(second.id, { status: 'running' }).status).toBe('running');
    } finally {
      db.close();
    }
  });

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
      expect(applied.created_goals[0].metadata).toMatchObject({
        execution_source: 'goal_batch_import',
        attempt_count: 0,
      });
      expect(applied.created_goals[0].budget).toMatchObject({ max_failure_count: 2 });
    } finally {
      db.close();
    }
  });

  it('limits autonomous batches to three verifiable goals', () => {
    const db = makeDb();
    try {
      const service = new GoalBatchService(db);
      const goals = Array.from({ length: 4 }, (_, index) => ({
        id: `goal-${index}`,
        title: `Goal ${index}`,
        acceptance: [`Outcome ${index} is verified`],
      }));
      const preview = service.preview({ batch: { goals } });
      expect(preview.errors).toContainEqual({ id: 'batch', error: 'maximum_3_goals_per_batch' });
      expect(() => service.apply({ batch: { goals } })).toThrow('GOAL_BATCH_INVALID');
      expect(counts(db).goals).toBe(0);
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
