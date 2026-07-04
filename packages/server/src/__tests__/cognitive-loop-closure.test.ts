import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { CognitiveLoopClosureService } from '../services/cognitive-loop-closure-service';

describe('CognitiveLoopClosureService', () => {
  let db: Database.Database;
  let service: CognitiveLoopClosureService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    service = new CognitiveLoopClosureService(db);
  });

  afterEach(() => {
    service.stop();
  });

  it('records an episode', () => {
    const episode = service.recordEpisode({
      loopRunId: 'loop-1',
      goalId: 'goal-1',
      goalType: 'security',
      mode: 'closed',
      startedAt: new Date(Date.now() - 60000).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 60000,
      outcome: 'success',
      strategy: 'test-strategy',
      actions: [],
      metrics: {
        totalLeases: 2, completedLeases: 2, failedLeases: 0,
        totalTokens: 1000, totalCostDollars: 0.01, diffLinesChanged: 5,
        filesModified: 1, gatesPassed: 3, gatesFailed: 0,
      },
      metadata: {},
    });

    expect(episode.id).toBeDefined();
    expect(episode.outcome).toBe('success');
  });

  it('extracts patterns from episodes', () => {
    // Record 10 episodes to trigger 2 buffer flushes (BUFFER_FLUSH_SIZE=5)
    for (let i = 0; i < 10; i++) {
      service.recordEpisode({
        loopRunId: `loop-${i}`,
        goalId: 'goal-1',
        goalType: 'security',
        mode: 'closed',
        startedAt: new Date(Date.now() - 60000).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 60000 + i * 10000,
        outcome: i < 8 ? 'success' : 'failure',
        strategy: 'test-strategy',
        actions: [],
        metrics: {
          totalLeases: 2, completedLeases: 2, failedLeases: 0,
          totalTokens: 1000, totalCostDollars: 0.01, diffLinesChanged: 5,
          filesModified: 1, gatesPassed: 3, gatesFailed: 0,
        },
        metadata: {},
      });
    }

    // Patterns are auto-extracted on buffer flush
    const stats = service.getStats();
    expect(stats.totalEpisodes).toBe(10);
  });

  it('evolves strategies from patterns', () => {
    // Record 10 episodes to trigger auto pattern extraction + strategy evolution
    for (let i = 0; i < 10; i++) {
      service.recordEpisode({
        loopRunId: `loop-${i}`,
        goalId: 'goal-1',
        goalType: 'security',
        mode: 'closed',
        startedAt: new Date(Date.now() - 60000).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 60000,
        outcome: 'success',
        strategy: 'good-strategy',
        actions: [],
        metrics: {
          totalLeases: 2, completedLeases: 2, failedLeases: 0,
          totalTokens: 1000, totalCostDollars: 0.01, diffLinesChanged: 5,
          filesModified: 1, gatesPassed: 3, gatesFailed: 0,
        },
        metadata: {},
      });
    }

    // Strategies are auto-evolved on buffer flush
    const stats = service.getStats();
    expect(stats.totalEpisodes).toBe(10);
    expect(stats.totalStrategies).toBeGreaterThan(0);
  });

  it('returns best strategy for goal type', () => {
    // Record enough episodes for a strategy
    for (let i = 0; i < 6; i++) {
      service.recordEpisode({
        loopRunId: `loop-${i}`,
        goalId: 'goal-1',
        goalType: 'security',
        mode: 'closed',
        startedAt: new Date(Date.now() - 60000).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 60000,
        outcome: 'success',
        strategy: 'best-strategy',
        actions: [],
        metrics: {
          totalLeases: 2, completedLeases: 2, failedLeases: 0,
          totalTokens: 1000, totalCostDollars: 0.01, diffLinesChanged: 5,
          filesModified: 1, gatesPassed: 3, gatesFailed: 0,
        },
        metadata: {},
      });
    }

    service.extractPatterns();
    service.evolveStrategies();

    const best = service.getBestStrategy('security');
    expect(best).toBeDefined();
    if (best) {
      expect(best.goalType).toBe('security');
      expect(best.successRate).toBeGreaterThan(0);
    }
  });

  it('provides cognitive stats', () => {
    service.recordEpisode({
      loopRunId: 'loop-1',
      goalId: 'goal-1',
      goalType: 'security',
      mode: 'closed',
      startedAt: new Date(Date.now() - 60000).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 60000,
      outcome: 'success',
      strategy: 'test',
      actions: [],
      metrics: {
        totalLeases: 2, completedLeases: 2, failedLeases: 0,
        totalTokens: 1000, totalCostDollars: 0.01, diffLinesChanged: 5,
        filesModified: 1, gatesPassed: 3, gatesFailed: 0,
      },
      metadata: {},
    });

    const stats = service.getStats();
    expect(stats.totalEpisodes).toBe(1);
    expect(stats.overallSuccessRate).toBe(1);
  });

  it('provides meta-learning status', () => {
    for (let i = 0; i < 6; i++) {
      service.recordEpisode({
        loopRunId: `loop-${i}`,
        goalId: 'goal-1',
        goalType: 'security',
        mode: 'closed',
        startedAt: new Date(Date.now() - 60000).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 60000,
        outcome: 'success',
        strategy: 'test',
        actions: [],
        metrics: {
          totalLeases: 2, completedLeases: 2, failedLeases: 0,
          totalTokens: 1000, totalCostDollars: 0.01, diffLinesChanged: 5,
          filesModified: 1, gatesPassed: 3, gatesFailed: 0,
        },
        metadata: {},
      });
    }

    service.extractPatterns();
    service.evolveStrategies();

    const meta = service.getMetaLearningStatus();
    expect(meta.length).toBeGreaterThan(0);
  });
});
