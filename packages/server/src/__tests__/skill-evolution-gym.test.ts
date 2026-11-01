import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SkillEvolutionGym } from '../services/skill-evolution-gym';
import { PromptPatternRegistry } from '../services/prompt-pattern-registry';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

const govMock = vi.hoisted(() => ({ runEval: vi.fn() }));
vi.mock('../services/openmythos-eval-service', () => ({
  OpenMythosEvalService: class {
    runEval = govMock.runEval;
  },
}));

let db: Database.Database;
let gym: SkillEvolutionGym;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  gym = new SkillEvolutionGym(db);
  govMock.runEval.mockReset();
});

afterEach(() => { db?.close(); });

describe('G126: SkillEvolutionGym', () => {
  describe('evaluateSkill', () => {
    it('computes the exact mean of metric values', () => {
      const result = gym.evaluateSkill('skill-1', { a: 2, b: 4 });
      expect(result.score).toBe(3);
      expect(result.skillId).toBe('skill-1');
      expect(result.metrics).toEqual({ a: 2, b: 4 });
      expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('returns score 0 for empty metrics (guards against division by zero)', () => {
      expect(gym.evaluateSkill('skill-empty', {}).score).toBe(0);
    });

    it('computes the mean for a single metric', () => {
      expect(gym.evaluateSkill('skill-single', { x: 5 }).score).toBe(5);
    });

    it('persists the evaluation row with score and metrics_json', () => {
      gym.evaluateSkill('skill-persist', { a: 1, b: 3 });
      const row = db.prepare('SELECT skill_id, score, metrics_json, eval_type FROM gym_evaluations WHERE skill_id = ?').get('skill-persist') as { skill_id: string; score: number; metrics_json: string; eval_type: string };
      expect(row.score).toBe(2);
      expect(JSON.parse(row.metrics_json)).toEqual({ a: 1, b: 3 });
      expect(row.eval_type).toBe('functional');
    });
  });

  describe('exploreDomain', () => {
    it('reports no patterns when db is empty', () => {
      const result = gym.exploreDomain('quantum-computing');
      expect(result.domain).toBe('quantum-computing');
      expect(result.patternsFound).toBe(0);
      expect(result.topPattern).toBeNull();
      expect(result.recommendation).toBe('No patterns found for "quantum-computing" — consider generating swarm episodes');
    });

    it('reports found skill patterns with the top pattern name', () => {
      const episode = { id: 'ep-1', topic: 'Fix bugs', domains: ['typescript'], steps: [{ role: 'maker', action: 'analyze', outcome: 'success' }], success: true, durationMs: 30000 };
      gym.ingestEpisode(episode);
      const result = gym.exploreDomain('typescript');
      expect(result.patternsFound).toBe(1);
      expect(result.topPattern).toBe('Pattern: Fix bugs');
      expect(result.recommendation).toBe('Found 1 patterns — top: "Pattern: Fix bugs"');
    });

    it('reports prompt patterns when no skill patterns match the domain', () => {
      const prompts = new PromptPatternRegistry(db);
      prompts.register('prompt-1', 'template', 'rust');
      const result = gym.exploreDomain('rust');
      expect(result.patternsFound).toBe(0);
      expect(result.topPattern).toBeNull();
      expect(result.recommendation).toBe('No skill patterns, but 1 prompt patterns available');
    });

    it('excludes skill patterns whose domains do not include the queried domain', () => {
      const episode = { id: 'ep-x', topic: 'Go work', domains: ['go'], steps: [{ role: 'maker', action: 'build', outcome: 'success' }], success: true, durationMs: 1000 };
      gym.ingestEpisode(episode);
      const result = gym.exploreDomain('java');
      expect(result.patternsFound).toBe(0);
      expect(result.topPattern).toBeNull();
    });
  });

  describe('ingestEpisode', () => {
    it('creates a pattern and evaluation for a successful episode with exact metrics', () => {
      const episode = { id: 'ep-1', topic: 'Fix bugs', domains: ['typescript'], steps: [{ role: 'maker', action: 'analyze', outcome: 'success' }], success: true, durationMs: 30000 };
      const result = gym.ingestEpisode(episode);
      expect(result.patterns).toHaveLength(1);
      expect(result.patterns[0].name).toBe('Pattern: Fix bugs');
      expect(result.evaluation).not.toBeNull();
      expect(result.evaluation!.metrics).toEqual({ success: 1, duration: 0.5, steps: 1 });
    });

    it('caps the duration metric at 1 for episodes longer than 60s', () => {
      const episode = { id: 'ep-2', topic: 'Long task', domains: ['typescript'], steps: [{ role: 'maker', action: 'work', outcome: 'success' }], success: true, durationMs: 120000 };
      const result = gym.ingestEpisode(episode);
      expect(result.evaluation!.metrics.duration).toBe(1);
    });

    it('records success 0 for a failed episode (no patterns, no evaluation)', () => {
      const episode = { id: 'ep-3', topic: 'Failed task', domains: ['typescript'], steps: [{ role: 'maker', action: 'work', outcome: 'success' }], success: false, durationMs: 30000 };
      const result = gym.ingestEpisode(episode);
      expect(result.patterns).toHaveLength(0);
      expect(result.evaluation).toBeNull();
    });

    it('returns no evaluation when there are no successful steps', () => {
      const episode = { id: 'ep-4', topic: 'No success steps', domains: ['typescript'], steps: [{ role: 'maker', action: 'work', outcome: 'failure' }], success: true, durationMs: 30000 };
      const result = gym.ingestEpisode(episode);
      expect(result.patterns).toHaveLength(0);
      expect(result.evaluation).toBeNull();
    });

    it('counts the number of steps in the evaluation metrics', () => {
      const episode = { id: 'ep-5', topic: 'Multi-step', domains: ['typescript'], steps: [{ role: 'maker', action: 'a', outcome: 'success' }, { role: 'maker', action: 'b', outcome: 'success' }], success: true, durationMs: 10000 };
      const result = gym.ingestEpisode(episode);
      expect(result.evaluation!.metrics.steps).toBe(2);
    });
  });

  describe('getLeaderboard', () => {
    it('orders skills by average score descending with exact averages and counts', () => {
      gym.evaluateSkill('skill-high', { s: 1 });
      gym.evaluateSkill('skill-high', { s: 1 });
      gym.evaluateSkill('skill-low', { s: 0 });
      const board = gym.getLeaderboard(10);
      expect(board).toHaveLength(2);
      expect(board[0]).toEqual({ skillId: 'skill-high', avgScore: 1, evaluations: 2 });
      expect(board[1]).toEqual({ skillId: 'skill-low', avgScore: 0, evaluations: 1 });
    });

    it('respects the limit parameter', () => {
      for (let i = 0; i < 5; i++) gym.evaluateSkill(`skill-${i}`, { s: i });
      expect(gym.getLeaderboard(3)).toHaveLength(3);
    });

    it('returns an empty array when the table is missing', () => {
      db.exec('DROP TABLE gym_evaluations');
      expect(gym.getLeaderboard(10)).toEqual([]);
    });
  });

  describe('getStats', () => {
    it('counts evaluations and deduplicates domains across patterns', () => {
      const ep1 = { id: 'ep-a', topic: 'Task A', domains: ['dev', 'test'], steps: [{ role: 'maker', action: 'a', outcome: 'success' }], success: true, durationMs: 1000 };
      const ep2 = { id: 'ep-b', topic: 'Task B', domains: ['dev', 'ops'], steps: [{ role: 'maker', action: 'b', outcome: 'success' }], success: true, durationMs: 1000 };
      gym.ingestEpisode(ep1);
      gym.ingestEpisode(ep2);
      gym.evaluateSkill('skill-x', { s: 1 });
      const stats = gym.getStats();
      expect(stats.totalEvaluations).toBe(3);
      expect(stats.totalPatterns).toBe(2);
      expect(stats.domains.sort()).toEqual(['dev', 'ops', 'test']);
    });

    it('returns 0 evaluations without throwing when the table is missing', () => {
      db.exec('DROP TABLE gym_evaluations');
      const stats = gym.getStats();
      expect(stats.totalEvaluations).toBe(0);
      expect(Array.isArray(stats.domains)).toBe(true);
    });
  });

  describe('getGovernanceHistory', () => {
    it('returns governance rows with score scaled by 5 and the passed flag', () => {
      db.prepare("INSERT INTO gym_evaluations (id, skill_id, score, metrics_json, eval_type, created_at) VALUES (?, ?, ?, ?, 'governance_benchmark', ?)")
        .run('gov-1', 'skill-gov', 0.8, JSON.stringify({ overallScore: 4, categoryScores: { safety: 4 }, passed: true }), '2026-01-01 00:00:00');
      const history = gym.getGovernanceHistory('skill-gov', 10);
      expect(history).toHaveLength(1);
      expect(history[0].score).toBe(4);
      expect(history[0].passed).toBe(true);
      expect(history[0].timestamp).toBe('2026-01-01 00:00:00');
    });

    it('excludes functional evaluations and other skills', () => {
      db.prepare("INSERT INTO gym_evaluations (id, skill_id, score, metrics_json, eval_type) VALUES (?, ?, ?, ?, 'governance_benchmark')")
        .run('gov-a', 'skill-gov', 0.8, JSON.stringify({ passed: true }));
      db.prepare("INSERT INTO gym_evaluations (id, skill_id, score, metrics_json, eval_type) VALUES (?, ?, ?, ?, 'functional')")
        .run('gov-b', 'skill-gov', 0.5, '{}');
      db.prepare("INSERT INTO gym_evaluations (id, skill_id, score, metrics_json, eval_type) VALUES (?, ?, ?, ?, 'governance_benchmark')")
        .run('gov-c', 'skill-other', 0.9, JSON.stringify({ passed: false }));
      expect(gym.getGovernanceHistory('skill-gov', 10)).toHaveLength(1);
    });

    it('orders by created_at descending', () => {
      db.prepare("INSERT INTO gym_evaluations (id, skill_id, score, metrics_json, eval_type, created_at) VALUES (?, ?, ?, ?, 'governance_benchmark', ?)")
        .run('gov-old', 'skill-gov', 0.8, JSON.stringify({ passed: true }), '2026-01-01 00:00:00');
      db.prepare("INSERT INTO gym_evaluations (id, skill_id, score, metrics_json, eval_type, created_at) VALUES (?, ?, ?, ?, 'governance_benchmark', ?)")
        .run('gov-new', 'skill-gov', 0.6, JSON.stringify({ passed: false }), '2026-01-02 00:00:00');
      const history = gym.getGovernanceHistory('skill-gov', 10);
      expect(history[0].score).toBe(3);
      expect(history[1].score).toBe(4);
    });

    it('defaults passed to false on malformed metrics_json', () => {
      db.prepare("INSERT INTO gym_evaluations (id, skill_id, score, metrics_json, eval_type) VALUES (?, ?, ?, ?, 'governance_benchmark')")
        .run('gov-bad', 'skill-gov', 0.8, 'not-json');
      const history = gym.getGovernanceHistory('skill-gov', 10);
      expect(history).toHaveLength(1);
      expect(history[0].passed).toBe(false);
    });

    it('returns an empty array when the table is missing', () => {
      db.exec('DROP TABLE gym_evaluations');
      expect(gym.getGovernanceHistory('skill-gov', 10)).toEqual([]);
    });
  });

  describe('runGovernanceEvaluation', () => {
    it('stores the normalized score and returns the original overall score with passed=true', async () => {
      govMock.runEval.mockResolvedValue({ overallScore: 4, categoryScores: { safety: 4 } });
      const result = await gym.runGovernanceEvaluation('skill-gov-1');
      expect(result.score).toBe(4);
      expect(result.passed).toBe(true);
      expect(result.categoryScores).toEqual({ safety: 4 });
      const row = db.prepare("SELECT score, eval_type, metrics_json FROM gym_evaluations WHERE skill_id = ? AND eval_type = 'governance_benchmark'").get('skill-gov-1') as { score: number; eval_type: string; metrics_json: string };
      expect(row.score).toBeCloseTo(0.8, 10);
      const stored = JSON.parse(row.metrics_json);
      expect(stored.overallScore).toBe(4);
      expect(stored.passed).toBe(true);
      expect(stored.categoryScores).toEqual({ safety: 4 });
    });

    it('marks passed=true at the exact 3.5 threshold', async () => {
      govMock.runEval.mockResolvedValue({ overallScore: 3.5, categoryScores: {} });
      expect((await gym.runGovernanceEvaluation('skill-gov-2')).passed).toBe(true);
    });

    it('marks passed=false below the 3.5 threshold', async () => {
      govMock.runEval.mockResolvedValue({ overallScore: 3.4, categoryScores: {} });
      expect((await gym.runGovernanceEvaluation('skill-gov-3')).passed).toBe(false);
    });
  });
});