import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ContinuousLearningLoop } from '../services/continuous-learning-loop';
import { createTestDb } from './helpers/test-db';


let db: Database.Database;
let loop: ContinuousLearningLoop;

beforeEach(() => {
  db = createTestDb();
  db.pragma('foreign_keys = ON');
  
  
  loop = new ContinuousLearningLoop(db, { intervalMs: 100 });
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

  it('does not reprocess completed runs across service instances', async () => {
    db.prepare(`
      INSERT INTO loop_runs (id, loop_name, mode, status, created_at, updated_at)
      VALUES ('learn-once', 'repo-maintenance-loop', 'closed', 'completed', datetime('now', '-1 minute'), datetime('now'))
    `).run();
    const first = await loop.runCycle();
    const restarted = new ContinuousLearningLoop(db);
    const second = await restarted.runCycle();
    expect(first.episodesIngested).toBe(1);
    expect(first.reflectionsGenerated).toBe(1);
    expect(second.episodesIngested).toBe(0);
    expect(second.reflectionsGenerated).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM self_model_snapshots').get() as { count: number }).count).toBe(2);
  });

  it('start/stop timer', () => {
    vi.useFakeTimers();
    const runCycle = vi.spyOn(loop, 'runCycle').mockResolvedValue({} as any);
    loop.start();
    vi.advanceTimersByTime(100);
    expect(runCycle).toHaveBeenCalledTimes(1);
    loop.stop();
    vi.advanceTimersByTime(100);
    expect(runCycle).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
