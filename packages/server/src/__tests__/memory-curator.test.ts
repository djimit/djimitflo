import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryCurator } from '../services/memory-curator';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let curator: MemoryCurator;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  curator = new MemoryCurator(db);
});

afterEach(() => { db?.close(); });

describe('G121: MemoryCurator', () => {
  it('curates new episode', () => {
    const result = curator.curate({ id: 'ep-1', type: 'episode', content: 'Test episode content', source: 'test', timestamp: new Date().toISOString() });
    expect(result.isNew).toBe(true);
    expect(result.record.id).toBeDefined();
  });

  it('classifies type', () => {
    const result = curator.curate({ id: 'ep-2', type: 'skill_episode', content: 'Skill content', source: 'gym', timestamp: new Date().toISOString() });
    expect(result.record.type).toBe('skill');
  });

  it('calculates confidence', () => {
    const result = curator.curate({ id: 'ep-3', type: 'episode', content: 'A'.repeat(200), source: 'verified:swarm', timestamp: new Date().toISOString() });
    expect(result.record.confidence).toBeGreaterThan(0.5);
  });

  it('curates batch', () => {
    const episodes = [
      { id: 'ep-4', type: 'episode', content: 'Content 1', source: 'test', timestamp: new Date().toISOString() },
      { id: 'ep-5', type: 'episode', content: 'Content 2', source: 'test', timestamp: new Date().toISOString() },
    ];
    const results = curator.curateBatch(episodes);
    expect(results.length).toBe(2);
  });

  it('gets episodes', () => {
    curator.curate({ id: 'ep-6', type: 'episode', content: 'Content', source: 'test', timestamp: new Date().toISOString() });
    const episodes = curator.getEpisodes(10);
    expect(episodes.length).toBeGreaterThanOrEqual(1);
  });
});
