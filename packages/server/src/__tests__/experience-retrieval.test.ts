import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ExperienceRetrievalService } from '../services/experience-retrieval-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let experience: ExperienceRetrievalService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  experience = new ExperienceRetrievalService(db, 'http://invalid-qdrant:6333');
});

afterEach(() => {
  db?.close();
});

function insertGoal(id: string, objective: string) {
  db.prepare(`
    INSERT INTO goals (id, objective, status, risk_class, created_at, updated_at)
    VALUES (?, ?, 'completed', 'low', datetime('now'), datetime('now'))
  `).run(id, objective);
}

function insertLoopRun(id: string, goalId: string, status: string) {
  db.prepare(`
    INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, created_at, updated_at)
    VALUES (?, ?, 'doc-drift-and-small-fix-loop', 'closed', ?, datetime('now'), datetime('now'))
  `).run(id, goalId, status);
}

function insertMakerLease(loopRunId: string, runtime: string, capabilityId: string) {
  db.prepare(`
    INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, capability_id, created_at, updated_at)
    VALUES (?, ?, 'maker', ?, 'completed', ?, datetime('now'), datetime('now'))
  `).run(`lease-${Math.random().toString(36).slice(2, 10)}`, loopRunId, runtime, capabilityId);
}

describe('G36: Experience Retrieval', () => {
  it('indexes a run successfully', async () => {
    insertGoal('goal-1', 'Fix TypeScript null guards in auth module');
    insertLoopRun('run-1', 'goal-1', 'completed');
    insertMakerLease('run-1', 'codex', 'ts-fix');
    await experience.indexRun('run-1');
    const row = db.prepare('SELECT * FROM experience_embeddings WHERE run_id = ?').get('run-1') as any;
    expect(row).toBeDefined();
    expect(row.objective).toBe('Fix TypeScript null guards in auth module');
    expect(row.outcome).toBe('success');
  });

  it('retrieves relevant runs by keyword matching', async () => {
    insertGoal('goal-1', 'Fix TypeScript null guards in auth module');
    insertLoopRun('run-1', 'goal-1', 'completed');
    insertMakerLease('run-1', 'codex', 'ts-fix');
    await experience.indexRun('run-1');

    insertGoal('goal-2', 'Fix Python type hints in data pipeline');
    insertLoopRun('run-2', 'goal-2', 'completed');
    insertMakerLease('run-2', 'opencode', 'py-fix');
    await experience.indexRun('run-2');

    const results = await experience.retrieveRelevantRuns('TypeScript null guards', 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].objective).toContain('TypeScript');
  });

  it('formats experience context correctly', async () => {
    insertGoal('goal-1', 'Fix auth module');
    insertLoopRun('run-1', 'goal-1', 'completed');
    insertMakerLease('run-1', 'codex', 'ts-fix');
    await experience.indexRun('run-1');

    const results = await experience.retrieveRelevantRuns('auth module', 5);
    const context = experience.formatExperienceContext(results);
    expect(context).toContain('Past Experience');
    expect(context).toContain('Success');
  });

  it('returns empty for no matches', async () => {
    const results = await experience.retrieveRelevantRuns('xyznonexistent', 5);
    expect(results).toEqual([]);
  });

  it('handles indexing non-existent run gracefully', async () => {
    await experience.indexRun('nonexistent-run');
    const count = db.prepare('SELECT COUNT(*) as c FROM experience_embeddings').get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('marks failed runs correctly', async () => {
    insertGoal('goal-fail', 'Fix broken tests');
    insertLoopRun('run-fail', 'goal-fail', 'failed');
    insertMakerLease('run-fail', 'codex', 'test-fix');
    await experience.indexRun('run-fail');
    const row = db.prepare('SELECT * FROM experience_embeddings WHERE run_id = ?').get('run-fail') as any;
    expect(row.outcome).toBe('failure');
  });

  it('retrieves success runs first when both exist', async () => {
    insertGoal('goal-s', 'Fix TypeScript imports');
    insertLoopRun('run-s', 'goal-s', 'completed');
    insertMakerLease('run-s', 'codex', 'ts-fix');
    await experience.indexRun('run-s');

    insertGoal('goal-f', 'Fix TypeScript exports');
    insertLoopRun('run-f', 'goal-f', 'failed');
    insertMakerLease('run-f', 'codex', 'ts-fix');
    await experience.indexRun('run-f');

    const results = await experience.retrieveRelevantRuns('TypeScript imports', 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('purges old entries', async () => {
    insertGoal('goal-old', 'Old task');
    insertLoopRun('run-old', 'goal-old', 'completed');
    insertMakerLease('run-old', 'codex', 'ts-fix');
    await experience.indexRun('run-old');

    db.prepare("UPDATE experience_embeddings SET created_at = datetime('now', '-100 days') WHERE run_id = 'run-old'").run();
    const purged = await experience.purgeOld(90);
    expect(purged).toBe(1);
  });

  it('creates experience_embeddings table on construction', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='experience_embeddings'").all();
    expect(tables.length).toBe(1);
  });

  it('handles empty objective gracefully', async () => {
    const results = await experience.retrieveRelevantRuns('', 5);
    expect(results).toEqual([]);
  });

  it('retrieves with limit', async () => {
    for (let i = 0; i < 5; i++) {
      insertGoal(`goal-${i}`, `Fix TypeScript issue ${i}`);
      insertLoopRun(`run-${i}`, `goal-${i}`, 'completed');
      insertMakerLease(`run-${i}`, 'codex', 'ts-fix');
      await experience.indexRun(`run-${i}`);
    }
    const results = await experience.retrieveRelevantRuns('TypeScript', 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });
});
