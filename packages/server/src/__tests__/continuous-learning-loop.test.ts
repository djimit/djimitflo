import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ContinuousLearningLoop } from '../services/continuous-learning-loop';
import { createTestDb } from './helpers/test-db';


let db: Database.Database;
let loop: ContinuousLearningLoop;

beforeEach(() => {
  db = createTestDb();
  db.pragma('foreign_keys = ON');
  
  
  loop = new ContinuousLearningLoop(db, { intervalMs: 999999999 });
});

afterEach(() => { db?.close(); loop.stop(); });

describe('G127: Continuous Learning Loop', () => {
  it('runs a learning cycle', async () => {
    const result = await loop.runCycle();
    expect(result.id).toBeDefined();
    expect(result.timestamp).toBeDefined();
  });

  it('tracks history', async () => {
    await loop.runCycle();
    await loop.runCycle();
    expect(loop.getHistory(10).length).toBe(2);
  });

  it('gets last cycle', async () => {
    await loop.runCycle();
    expect(loop.getLastCycle()).not.toBeNull();
  });

  it('ignores foreign cycle records in history and watermarks', async () => {
    await loop.runCycle();
    db.prepare('INSERT INTO learning_cycles (id, result_json) VALUES (?, ?)').run(
      'foreign-cycle',
      JSON.stringify({ timestamp: '2999-01-01T00:00:00.000Z', sourceWatermark: 'foreign' }),
    );

    expect(loop.getHistory(10)).toHaveLength(1);
    expect(loop.getLastCycle()?.producer).toBe('continuous-learning-loop');
  });

  it('learns only verified maker runs and does not reflect twice after restart', async () => {
    const now = new Date().toISOString();
    const insertRun = db.prepare(`
      INSERT INTO loop_runs (
        id, loop_name, mode, status, findings_json, plan_json, gates_json,
        next_actions_json, metadata, created_at, updated_at, completed_at
      ) VALUES (?, 'doc-drift-and-small-fix-loop', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?, ?)
    `);
    insertRun.run('verified-run', JSON.stringify({ dry_run: true }), now, now, now);
    insertRun.run('discovery-only-run', JSON.stringify({ dry_run: true, outcome: 'no_change_required' }), now, now, now);
    db.prepare(`
      INSERT INTO worker_leases (
        id, loop_run_id, role, runtime, status, budget_json, metadata, created_at, updated_at
      ) VALUES ('verified-maker', 'verified-run', 'maker', 'mock', 'completed', '{}', '{}', ?, ?)
    `).run(now, now);

    const first = await loop.runCycle();
    expect(first.episodesIngested).toBe(1);
    expect(first.reflectionsGenerated).toBe(1);

    loop.stop();
    loop = new ContinuousLearningLoop(db, { intervalMs: 999999999 });
    const second = await loop.runCycle();
    expect(second.episodesIngested).toBe(0);
    expect(second.reflectionsGenerated).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM reflections WHERE loop_run_id = 'verified-run'").get() as { count: number }).count).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM reflections WHERE loop_run_id = 'discovery-only-run'").get() as { count: number }).count).toBe(0);
  });

  it('start/stop timer', () => {
    loop.start();
    loop.stop();
    expect(true).toBe(true);
  });
});
