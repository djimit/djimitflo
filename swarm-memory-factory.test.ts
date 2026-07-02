import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SwarmMemoryFactory } from '../services/swarm-memory-factory';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let factory: SwarmMemoryFactory;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  factory = new SwarmMemoryFactory(db);
});

afterEach(() => { db?.close(); });

describe('G129: Swarm Memory Factory', () => {
  it('processes episode', () => {
    const result = factory.processEpisode({ id: 'ep-1', topic: 'Test', domains: ['test'], participants: [{ agentId: 'a1', role: 'maker', output: 'Fixed' }], outcome: 'success', durationMs: 30000 });
    expect(result.episodeId).toBe('ep-1');
    expect(result.memoriesStored).toBeGreaterThan(0);
  });

  it('gets stats', () => {
    factory.processEpisode({ id: 'ep-2', topic: 'T', domains: ['d'], participants: [], outcome: 'success', durationMs: 10000 });
    const stats = factory.getStats();
    expect(stats.totalEpisodes).toBe(1);
  });
});
