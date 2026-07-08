import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { CognitiveLoopClosureService } from '../services/cognitive-loop-closure-service';
import { swarmEventBus } from '../services/swarm-event-bus';

describe('Cognitive Loop Integration', () => {
  let db: Database.Database;
  let service: CognitiveLoopClosureService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    service = new CognitiveLoopClosureService(db);
    service.start();
  });

  afterEach(() => {
    service.stop();
  });

  function emitLoopCompleted(overrides: Record<string, unknown> = {}) {
    swarmEventBus.emit('loop_completed', {
      loopRunId: `loop-${Math.random().toString(36).slice(2)}`,
      goalId: 'goal-1',
      goalType: 'doc-drift',
      mode: 'closed',
      status: 'completed',
      durationMs: 45000,
      strategy: 'maker-checker-v1',
      totalLeases: 3,
      completedLeases: 3,
      failedLeases: 0,
      startedAt: new Date(Date.now() - 45000).toISOString(),
      completedAt: new Date().toISOString(),
      ...overrides,
    });
  }

  it('auto-records episode when loop_completed event fires', () => {
    const statsBefore = service.getStats();
    expect(statsBefore.totalEpisodes).toBe(0);

    emitLoopCompleted();

    const statsAfter = service.getStats();
    expect(statsAfter.totalEpisodes).toBe(1);
  });

  it('records multiple episodes from events', () => {
    for (let i = 0; i < 3; i++) {
      emitLoopCompleted({ loopRunId: `loop-multi-${i}` });
    }

    const stats = service.getStats();
    expect(stats.totalEpisodes).toBe(3);
  });

  it('infers success outcome from completed status', () => {
    emitLoopCompleted({ status: 'completed' });

    const stats = service.getStats();
    expect(stats.overallSuccessRate).toBe(1);
  });

  it('infers failure outcome from failed status', () => {
    emitLoopCompleted({ status: 'failed', completedLeases: 0, failedLeases: 2 });

    const stats = service.getStats();
    expect(stats.totalEpisodes).toBe(1);
    expect(stats.overallSuccessRate).toBe(0);
  });

  it('auto-extracts patterns after buffer flush (5 episodes)', () => {
    for (let i = 0; i < 5; i++) {
      emitLoopCompleted({ loopRunId: `loop-flush-${i}`, strategy: 'test-strategy' });
    }

    const stats = service.getStats();
    expect(stats.totalEpisodes).toBe(5);
    expect(stats.totalPatterns).toBeGreaterThan(0);
  });

  it('provides best strategy after sufficient episodes and evolution', () => {
    // Emit 10 episodes to trigger 2 auto buffer flushes (each triggers pattern extraction + strategy evolution)
    for (let i = 0; i < 10; i++) {
      emitLoopCompleted({ loopRunId: `loop-strategy-${i}`, strategy: 'proven-strategy' });
    }

    const best = service.getBestStrategy('doc-drift');
    expect(best).not.toBeNull();
    if (best) {
      expect(best.goalType).toBe('doc-drift');
      expect(best.successRate).toBeGreaterThan(0);
    }
  });

  it('populates meta-learning after strategy evolution', () => {
    for (let i = 0; i < 10; i++) {
      emitLoopCompleted({ loopRunId: `loop-meta-${i}`, goalType: 'self-improvement' });
    }

    const meta = service.getMetaLearningStatus();
    expect(meta.length).toBeGreaterThan(0);
    const selfImprove = meta.find((m) => m.goalType === 'self-improvement');
    expect(selfImprove).toBeDefined();
  });
});
