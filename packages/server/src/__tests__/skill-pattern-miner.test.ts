import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SkillPatternMiner } from '../services/skill-pattern-miner';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let miner: SkillPatternMiner;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  miner = new SkillPatternMiner(db);
});

afterEach(() => { db?.close(); });

describe('G123: SkillPatternMiner', () => {
  it('mines pattern from successful episode', () => {
    const episode = { id: 'ep-1', topic: 'Fix TypeScript', domains: ['typescript'], steps: [{ role: 'maker', action: 'analyze', outcome: 'success' }, { role: 'checker', action: 'verify', outcome: 'success' }], success: true, durationMs: 30000 };
    const patterns = miner.mineFromEpisode(episode);
    expect(Array.isArray(patterns)).toBe(true);
  });

  it('gets patterns', () => {
    const patterns = miner.getPatterns(1, 10);
    expect(Array.isArray(patterns)).toBe(true);
  });

  it('mines from multiple episodes', () => {
    const episodes = [
      { id: 'ep-2', topic: 'A', domains: ['a'], steps: [{ role: 'maker', action: 'fix', outcome: 'success' }], success: true, durationMs: 10000 },
      { id: 'ep-3', topic: 'B', domains: ['b'], steps: [{ role: 'maker', action: 'fix', outcome: 'success' }], success: true, durationMs: 20000 },
    ];
    const patterns = miner.mineFromEpisodes(episodes);
    expect(Array.isArray(patterns)).toBe(true);
  });
});
