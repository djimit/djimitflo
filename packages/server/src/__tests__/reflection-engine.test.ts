import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ReflectionEngine } from '../services/reflection-engine';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let engine: ReflectionEngine;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  engine = new ReflectionEngine(db);
});

afterEach(() => {
  db?.close();
});

function insertRunWithLeases(runId: string, leases: Array<{ cap: string; status: string }>) {
  db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, created_at, updated_at) VALUES (?, 'doc-drift-and-small-fix-loop', 'closed', 'completed', datetime('now'), datetime('now'))").run(runId);
  for (const l of leases) {
    db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, capability_id, created_at, updated_at) VALUES (?, ?, 'maker', 'codex', ?, ?, datetime('now'), datetime('now'))").run(`${runId}-${l.cap}`, runId, l.status, l.cap);
  }
}

describe('G65: Reflection Engine', () => {
  it('reflects on successful run', () => {
    insertRunWithLeases('run-1', [{ cap: 'ts-fix', status: 'completed' }]);
    const reflection = engine.reflectOnRun('run-1');
    expect(reflection.whatWorked.length).toBe(1);
    expect(reflection.whatFailed.length).toBe(0);
  });

  it('reflects on failed run', () => {
    insertRunWithLeases('run-2', [{ cap: 'ts-fix', status: 'failed' }]);
    const reflection = engine.reflectOnRun('run-2');
    expect(reflection.whatFailed.length).toBe(1);
    expect(reflection.lessonsLearned.length).toBeGreaterThan(0);
  });

  it('generates improvement proposals', () => {
    insertRunWithLeases('run-3', [{ cap: 'ts-fix', status: 'failed' }]);
    engine.reflectOnRun('run-3');
    const improvements = engine.getProposedImprovements();
    expect(improvements.length).toBeGreaterThan(0);
  });

  it('extracts lessons learned', () => {
    insertRunWithLeases('run-4', [{ cap: 'ts-fix', status: 'failed' }, { cap: 'lint-fix', status: 'completed' }]);
    engine.reflectOnRun('run-4');
    const lessons = engine.getLessonsLearned();
    expect(lessons.length).toBeGreaterThan(0);
  });

  it('gets reflection history', () => {
    insertRunWithLeases('run-5', [{ cap: 'ts-fix', status: 'completed' }]);
    engine.reflectOnRun('run-5');
    const reflections = engine.getReflections(10);
    expect(reflections.length).toBe(1);
  });

  it('all success generates positive lesson', () => {
    insertRunWithLeases('run-6', [{ cap: 'ts-fix', status: 'completed' }, { cap: 'lint-fix', status: 'completed' }]);
    const reflection = engine.reflectOnRun('run-6');
    expect(reflection.lessonsLearned.some(l => l.includes('succeeded'))).toBe(true);
  });
});
