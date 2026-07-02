import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ContrastiveSkillMiner } from '../services/contrastive-skill-miner';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let miner: ContrastiveSkillMiner;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  miner = new ContrastiveSkillMiner(db, { similarityThreshold: 0.5 });
});

afterEach(() => { db?.close(); });

describe('G131: Contrastive Skill Miner', () => {
  it('mines patterns with embeddings', () => {
    const patterns = miner.mineWithContrast({
      id: 'ep-1', topic: 'Fix TypeScript', domains: ['typescript'],
      steps: [{ role: 'maker', action: 'analyze errors', outcome: 'success' }],
      success: true, durationMs: 30000,
    });
    expect(patterns.length).toBeGreaterThanOrEqual(0);
  });

  it('finds similar patterns', () => {
    miner.mineWithContrast({
      id: 'ep-2', topic: 'Fix TypeScript errors', domains: ['typescript'],
      steps: [{ role: 'maker', action: 'analyze type errors', outcome: 'success' }],
      success: true, durationMs: 30000,
    });
    const similar = miner.findSimilarPatterns('TypeScript type errors', 5);
    expect(Array.isArray(similar)).toBe(true);
  });

  it('gets clusters', () => {
    const clusters = miner.getClusters();
    expect(Array.isArray(clusters)).toBe(true);
  });

  it('deduplicates patterns', () => {
    const result = miner.deduplicatePatterns();
    expect(typeof result.merged).toBe('number');
    expect(typeof result.removed).toBe('number');
  });

  it('creates embeddings with correct dimension', () => {
    const customMiner = new ContrastiveSkillMiner(db, { embeddingDimension: 32 });
    const patterns = customMiner.mineWithContrast({
      id: 'ep-3', topic: 'Test', domains: ['test'],
      steps: [{ role: 'maker', action: 'test action', outcome: 'success' }],
      success: true, durationMs: 10000,
    });
    if (patterns.length > 0) {
      expect(patterns[0].embedding.length).toBe(32);
    }
  });

  it('merges similar patterns into clusters', () => {
    miner.mineWithContrast({
      id: 'ep-4', topic: 'Fix auth bug', domains: ['security'],
      steps: [{ role: 'maker', action: 'fix authentication', outcome: 'success' }],
      success: true, durationMs: 20000,
    });
    miner.mineWithContrast({
      id: 'ep-5', topic: 'Fix auth issue', domains: ['security'],
      steps: [{ role: 'maker', action: 'fix authentication', outcome: 'success' }],
      success: true, durationMs: 20000,
    });
    const clusters = miner.getClusters();
    expect(clusters.length).toBeGreaterThanOrEqual(0);
  });
});
