import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { GoalBatchService } from '../services/goal-batch-service';
import { GoalService } from '../services/goal-service';
import { LoopService } from '../services/loop-service';
import { isCanonicalLoopName } from '@djimitflo/shared';

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

  it('imports a versioned campaign in bounded waves and preserves assurance evidence', () => {
    const db = makeDb();
    try {
      const service = new GoalBatchService(db);
      const goal = (index: number) => ({
        key: `goal-${index}`,
        ...(index ? { depends_on: [`goal-${index - 1}`] } : {}),
        target: 'packages/server',
        api: { body: {
          objective: `Goal ${index}`,
          acceptance_criteria: ['Targeted regression passes'],
          constraints: ['network:deny'],
          falsification_tests: ['Invariant violation remains reproducible'],
          risk_class: 'medium',
          metadata: { recommended_loop: 'worldlab-regression-loop' },
        } },
      });
      const batch = {
        schema: 'djimit.openmythos.worldlab.goal.v1',
        campaign_id: 'campaign-1',
        change: 'worldlab-finding-1',
        source: { experiment_id: 'exp-1', finding_id: 'finding-1', evidence_hash: 'sha256:evidence' },
        finding: { failure_mode: 'epistemic_contagion', confidence: 0.94 },
        waves: [
          { id: 'wave-1', ordered_goals: [goal(0), goal(1), goal(2)] },
          { id: 'wave-2', ordered_goals: [goal(3), goal(4)] },
        ],
      };

      const preview = service.preview({ batch });
      expect(preview).toMatchObject({ schema: batch.schema, campaign_id: 'campaign-1', total: 5, valid: 5, blocked: 0 });
      const applied = service.apply({ batch });
      expect(applied.created_goals).toHaveLength(5);
      expect(applied.created_goals[3]).toMatchObject({
        constraints: ['network:deny'],
        metadata: {
          falsification_tests: ['Invariant violation remains reproducible'],
          openmythos_source: batch.source,
          openmythos_finding: batch.finding,
          goal_batch: { campaign_id: 'campaign-1', wave_id: 'wave-2' },
        },
      });
      expect((db.prepare('SELECT COUNT(*) count FROM swarm_evidence_edges').get() as { count: number }).count).toBe(10);
    } finally {
      db.close();
    }
  });

  it('previews the repository golden learning campaign without writes', () => {
    const db = makeDb();
    try {
      const service = new GoalBatchService(db, join(__dirname, '../../../..'));
      const before = counts(db);
      const preview = service.preview({ path: 'goals/golden-learning-campaign.batch.json' });
      expect(preview).toMatchObject({
        schema: 'djimit.openmythos.worldlab.goal.v1',
        campaign_id: 'djimit-golden-learning-20260907',
        total: 12,
        valid: 12,
        blocked: 0,
        writes: 0,
      });
      expect(preview.items.map((item) => item.wave_id)).toEqual([
        ...Array(3).fill('wave-0-truth-spine'),
        ...Array(3).fill('wave-1-independent-evidence'),
        ...Array(3).fill('wave-2-interaction-longitudinal'),
        ...Array(3).fill('wave-3-recovery-lifecycle'),
      ]);
      const batch = JSON.parse(readFileSync(join(__dirname, '../../../../goals/golden-learning-campaign.batch.json'), 'utf8'));
      expect(batch.waves.flatMap((wave: any) => wave.ordered_goals)
        .every((goal: any) => isCanonicalLoopName(goal.api.body.recommended_loop))).toBe(true);
      expect(counts(db)).toEqual(before);
    } finally {
      db.close();
    }
  });

  it('accepts a dependency imported by an earlier campaign wave', () => {
    const db = makeDb();
    try {
      const service = new GoalBatchService(db);
      service.apply({ batch: { goals: [{ id: 'prior', title: 'Prior', acceptance: ['Done'] }] } });
      const preview = service.preview({ batch: {
        goals: [{ id: 'next', title: 'Next', acceptance: ['Done'], depends_on: ['prior'] }],
      } });
      expect(preview.errors).toEqual([]);
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

  it('does not follow a goal-batch symlink outside the repository', () => {
    const db = makeDb();
    const repo = mkdtempSync(join(tmpdir(), 'goal-batch-repo-'));
    const outside = mkdtempSync(join(tmpdir(), 'goal-batch-outside-'));
    try {
      writeFileSync(join(outside, 'batch.json'), JSON.stringify({ goals: [] }));
      mkdirSync(join(repo, 'goals'));
      symlinkSync(join(outside, 'batch.json'), join(repo, 'goals/golden-learning-campaign.batch.json'));
      expect(() => new GoalBatchService(db, repo).preview({ path: 'goals/golden-learning-campaign.batch.json' }))
        .toThrow('GOAL_BATCH_PATH_FORBIDDEN');
    } finally {
      db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
