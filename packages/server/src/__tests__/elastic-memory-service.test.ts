import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ElasticMemoryService } from '../services/elastic-memory-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let memory: ElasticMemoryService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  memory = new ElasticMemoryService(db);
});

afterEach(() => {
  db?.close();
});

describe('G54: Elastic Memory', () => {
  it('recordQuery creates stats', () => {
    memory.recordQuery('test-collection');
    const stats = memory.getCollectionStats('test-collection');
    expect(stats).not.toBeNull();
    expect(stats!.queryRate).toBe(1);
  });

  it('measureCognitiveLoad returns 0 for empty', () => {
    expect(memory.measureCognitiveLoad()).toBe(0);
  });

  it('adjustAllocation sets tiers', () => {
    for (let i = 0; i < 15; i++) memory.recordQuery('hot-collection');
    for (let i = 0; i < 3; i++) memory.recordQuery('warm-collection');
    memory.recordQuery('cold-collection');
    memory.adjustAllocation();
    const hot = memory.getCollectionStats('hot-collection');
    expect(hot!.tier).toBe('hot');
  });

  it('setTier updates tier', () => {
    memory.recordQuery('tier-test');
    memory.setTier('tier-test', 'cold');
    const stats = memory.getCollectionStats('tier-test');
    expect(stats!.tier).toBe('cold');
  });

  it('getAllTiers returns sorted by query rate', () => {
    for (let i = 0; i < 10; i++) memory.recordQuery('high');
    for (let i = 0; i < 3; i++) memory.recordQuery('low');
    const tiers = memory.getAllTiers();
    expect(tiers.length).toBe(2);
    expect(tiers[0].name).toBe('high');
  });

  it('compressColdData returns count', () => {
    memory.recordQuery('compress-test');
    const compressed = memory.compressColdData(0);
    expect(compressed).toBeGreaterThanOrEqual(0);
  });
});
