import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SkillEvolutionGym } from '../services/skill-evolution-gym';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let gym: SkillEvolutionGym;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  gym = new SkillEvolutionGym(db);
});

afterEach(() => { db?.close(); });

describe('G126: SkillEvolutionGym', () => {
  it('evaluates skill', () => {
    const evalResult = gym.evaluateSkill('skill-1', { success: 1, duration: 0.5, steps: 3 });
    expect(evalResult.score).toBeGreaterThan(0);
    expect(evalResult.skillId).toBe('skill-1');
  });

  it('explores domain', () => {
    const result = gym.exploreDomain('quantum-computing');
    expect(result.domain).toBe('quantum-computing');
    expect(typeof result.recommendation).toBe('string');
  });

  it('ingests episode', () => {
    const episode = {
      id: 'ep-1', topic: 'Fix bugs', domains: ['typescript'],
      steps: [{ role: 'maker', action: 'analyze', outcome: 'success' }],
      success: true, durationMs: 30000,
    };
    const result = gym.ingestEpisode(episode);
    expect(result.patterns).toBeDefined();
  });

  it('gets leaderboard', () => {
    gym.evaluateSkill('skill-a', { success: 1 });
    gym.evaluateSkill('skill-b', { success: 0 });
    const leaderboard = gym.getLeaderboard(10);
    expect(Array.isArray(leaderboard)).toBe(true);
  });

  it('gets stats', () => {
    const stats = gym.getStats();
    expect(stats.totalEvaluations).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(stats.domains)).toBe(true);
  });
});
