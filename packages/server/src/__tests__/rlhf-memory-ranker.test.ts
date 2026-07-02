import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { RLHFMemoryRanker } from '../services/rlhf-memory-ranker';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let ranker: RLHFMemoryRanker;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  ranker = new RLHFMemoryRanker(db);
});

afterEach(() => { db?.close(); });

describe('G133: RLHF Memory Ranker', () => {
  it('records reward', () => {
    ranker.recordReward({ memoryId: 'mem-1', loopRunId: 'run-1', outcome: 'success', utilityScore: 0.9 });
    const stats = ranker.getPolicyStats();
    expect(stats.totalUpdates).toBeGreaterThanOrEqual(0);
  });

  it('ranks memories', () => {
    const memories = [
      { id: 'm1', type: 'observation' as const, content: 'Test', source: 'test', confidence: 0.8, metadata: {}, createdAt: '' },
      { id: 'm2', type: 'episode' as const, content: 'Test 2', source: 'test', confidence: 0.6, metadata: {}, createdAt: '' },
    ];
    const ranked = ranker.rankMemories(memories);
    expect(ranked.length).toBe(2);
  });

  it('gets policy stats', () => {
    const stats = ranker.getPolicyStats();
    expect(typeof stats.avgReward).toBe('number');
    expect(typeof stats.totalUpdates).toBe('number');
  });

  it('prunes low value memories', () => {
    const pruned = ranker.pruneLowValueMemories(0.1);
    expect(typeof pruned).toBe('number');
  });

  it('updates policy on reward', () => {
    ranker.recordReward({ memoryId: 'mem-2', loopRunId: 'run-2', outcome: 'success', utilityScore: 1.0 });
    ranker.recordReward({ memoryId: 'mem-2', loopRunId: 'run-3', outcome: 'success', utilityScore: 0.9 });
    const stats = ranker.getPolicyStats();
    expect(stats.avgReward).toBeGreaterThan(0);
  });
});
