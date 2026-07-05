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

  it('start/stop timer', () => {
    loop.start();
    loop.stop();
    expect(true).toBe(true);
  });
});
