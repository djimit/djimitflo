import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { CognitiveLoopClosureService } from '../services/cognitive-loop-closure-service';
import { MetaOrchestrationService } from '../services/meta-orchestration-service';
import { ProactiveMemoryService } from '../services/proactive-memory-service';
import { swarmEventBus } from '../services/swarm-event-bus';

/**
 * End-to-end integration tests for the self-driving learning pipe.
 *
 * Verifies the full data flow:
 * 1. loop_completed → cognitive episode recording
 * 2. Cognitive episodes → pattern extraction → strategy evolution
 * 3. Strategy recommendations → meta-orchestration routing
 * 4. Proactive memory → auto-relation discovery → consolidation
 * 5. Task execution → outcome recording → failure prediction
 */

describe('Learning Pipe E2E', () => {
  let db: ReturnType<typeof createTestDb>;
  let cognitive: CognitiveLoopClosureService;
  let meta: MetaOrchestrationService;
  let memory: ProactiveMemoryService;

  beforeEach(() => {
    db = createTestDb();
    cognitive = new CognitiveLoopClosureService(db);
    cognitive.start();
    meta = new MetaOrchestrationService(db);
    memory = new ProactiveMemoryService(db);
  });

  afterEach(() => {
    cognitive.stop();
    db.close();
  });

  describe('Cognitive Loop Closure', () => {
    it('records episode from loop_completed event', () => {
      swarmEventBus.emit('loop_completed', {
        loopRunId: 'loop-1',
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
      });

      const stats = cognitive.getStats();
      expect(stats.totalEpisodes).toBe(1);
    });

    it('extracts patterns after buffer flush (5 episodes)', () => {
      for (let i = 0; i < 5; i++) {
        swarmEventBus.emit('loop_completed', {
          loopRunId: `loop-flush-${i}`,
          goalId: 'goal-1',
          goalType: 'doc-drift',
          mode: 'closed',
          status: 'completed',
          durationMs: 30000,
          strategy: 'maker-checker-v1',
          totalLeases: 2,
          completedLeases: 2,
          failedLeases: 0,
          startedAt: new Date(Date.now() - 30000).toISOString(),
          completedAt: new Date().toISOString(),
        });
      }

      const stats = cognitive.getStats();
      expect(stats.totalEpisodes).toBe(5);
      expect(stats.totalPatterns).toBeGreaterThan(0);
    });

    it('evolves strategies from episodes', () => {
      for (let i = 0; i < 10; i++) {
        swarmEventBus.emit('loop_completed', {
          loopRunId: `loop-evolve-${i}`,
          goalId: 'goal-1',
          goalType: 'self-improvement',
          mode: 'closed',
          status: 'completed',
          durationMs: 60000,
          strategy: 'proven-strategy',
          totalLeases: 3,
          completedLeases: 3,
          failedLeases: 0,
          startedAt: new Date(Date.now() - 60000).toISOString(),
          completedAt: new Date().toISOString(),
        });
      }

      const best = cognitive.getBestStrategy('self-improvement');
      expect(best).not.toBeNull();
      if (best) {
        expect(best.goalType).toBe('self-improvement');
        expect(best.episodeCount).toBeGreaterThanOrEqual(3);
      }
    });
  });

  describe('Meta-Orchestration', () => {
    it('provides routing optimization for task type', () => {
      // Seed some outcomes
      for (let i = 0; i < 5; i++) {
        meta.recordOutcome({
          taskId: `task-${i}`,
          taskType: 'coding',
          title: 'Fix bug',
          description: 'Fix the bug',
          provider: 'litellm',
          model: 'coding',
          runtime: 'mock',
          success: true,
          durationMs: 5000,
          costDollars: 0.01,
          tags: ['bugfix'],
          metadata: {},
        });
      }

      const routing = meta.getRoutingOptimization('coding');
      expect(routing.recommendedModel).toBeDefined();
      expect(routing.expectedSuccessRate).toBeGreaterThan(0);
    });

    it('predicts failure for high-risk tasks', () => {
      const prediction = meta.predictFailure({
        title: 'Critical auth refactor',
        description: 'Refactor OAuth flow',
        priority: 'critical',
        riskLevel: 'high',
        executionMode: 'local',
        tags: ['security'],
        metadata: {},
      });
      expect(prediction.willFail).toBe(false); // No history = low confidence
      expect(prediction.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it('provides strategy recommendation after learning', () => {
      // Seed cognitive episodes
      for (let i = 0; i < 10; i++) {
        swarmEventBus.emit('loop_completed', {
          loopRunId: `loop-strategy-${i}`,
          goalId: 'goal-1',
          goalType: 'doc-drift',
          mode: 'closed',
          status: 'completed',
          durationMs: 30000,
          strategy: 'best-strategy',
          totalLeases: 2,
          completedLeases: 2,
          failedLeases: 0,
          startedAt: new Date(Date.now() - 30000).toISOString(),
          completedAt: new Date().toISOString(),
        });
      }

      const strategy = meta.getStrategyRecommendation('doc-drift');
      expect(strategy.strategy).toBeDefined();
      expect(strategy.confidence).toBeGreaterThan(0);
    });
  });

  describe('Proactive Memory', () => {
    it('stores and retrieves memories with relevance scoring', () => {
      const entry = memory.storeMemory({
        content: 'Database connection pool should be configured for max 10 connections',
        type: 'observation',
        ttlDays: 30,
      });

      expect(entry.id).toBeDefined();
      expect(entry.status).toBe('candidate');
      expect(entry.relevanceScore).toBe(0.5);

      // Access to boost relevance
      const accessed = memory.accessMemory(entry.id);
      expect(accessed).not.toBeNull();
      expect(accessed!.usageCount).toBe(1);
    });

    it('auto-discovers relations between similar memories', () => {
      memory.storeMemory({ content: 'Use connection pooling for database access', type: 'pattern' });
      memory.storeMemory({ content: 'Database connection pool improves performance', type: 'pattern' });
      memory.storeMemory({ content: 'Use caching for frequently accessed data', type: 'pattern' });

      const result = memory.autoDiscoverRelations(0.2);
      expect(result.discovered).toBeGreaterThan(0);
    });

    it('consolidates near-duplicate memories', () => {
      memory.storeMemory({ content: 'Use connection pooling for database', type: 'pattern' });
      memory.storeMemory({ content: 'Use connection pooling for database', type: 'pattern' });

      const result = memory.consolidateMemories();
      expect(result.merged).toBeGreaterThan(0);
    });

    it('runs full maintenance cycle', () => {
      // Store some memories
      for (let i = 0; i < 5; i++) {
        const entry = memory.storeMemory({
          content: `Memory ${i}: database optimization technique`,
          type: 'observation',
        });
        // Access some to boost relevance
        if (i < 2) memory.accessMemory(entry.id);
      }

      const result = memory.runMaintenanceCycle();
      expect(result.evaluated).toBe(5);
      expect(result).toHaveProperty('relationsDiscovered');
      expect(result).toHaveProperty('merged');
    });
  });

  describe('Full Pipe Integration', () => {
    it('processes loop outcome through entire learning pipe', () => {
      // 1. Loop completes → cognitive episode
      swarmEventBus.emit('loop_completed', {
        loopRunId: 'e2e-loop-1',
        goalId: 'e2e-goal-1',
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
      });

      // 2. Verify cognitive recorded the episode
      const cogStats = cognitive.getStats();
      expect(cogStats.totalEpisodes).toBe(1);

      // 3. Meta-orchestration can provide routing
      const routing = meta.getRoutingOptimization('doc-drift');
      expect(routing.recommendedModel).toBeDefined();

      // 4. Proactive memory stores the learning
      const mem = memory.storeMemory({
        content: 'Loop doc-drift completed successfully with maker-checker-v1 strategy',
        type: 'learning',
      });
      expect(mem.id).toBeDefined();

      // 5. Failure prediction works
      const prediction = meta.predictFailure({
        title: 'Similar doc-drift task',
        description: 'Fix documentation drift',
        priority: 'medium',
        riskLevel: 'low',
        executionMode: 'local',
        tags: ['doc-drift'],
        metadata: {},
      });
      expect(prediction.confidence).toBeGreaterThanOrEqual(0.5);
    });
  });
});
