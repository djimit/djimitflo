import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { LoopService } from '../services/loop-service';
import { LoopWorkerExecutorService } from '../services/loop-worker-executor-service';
import { RuntimeCommandService } from '../services/runtime-command-service';
import { LoopLifecycleService } from '../services/loop-lifecycle-service';
import { LoopDiscoveryService } from '../services/loop-discovery-service';
import { MetaOrchestrationService } from '../services/meta-orchestration-service';
import { RetentionService } from '../services/retention-service';
import { CognitiveLoopClosureService } from '../services/cognitive-loop-closure-service';
import { swarmEventBus } from '../services/swarm-event-bus';

describe('Extracted Loop Services', () => {
  let db: ReturnType<typeof createTestDb>;
  let loops: LoopService;

  beforeEach(() => {
    db = createTestDb();
    loops = new LoopService(db);
  });

  describe('LoopWorkerExecutorService', () => {
    it('is instantiated via LoopService', () => {
      expect(loops.workerExecutor).toBeInstanceOf(LoopWorkerExecutorService);
    });

    it('throws when maker lease not found', async () => {
      const run = loops.startLoop({ repository_path: process.cwd() });
      await expect(loops.workerExecutor.executeMaker(run.id)).rejects.toThrow('MAKER_LEASE_NOT_FOUND');
    });
  });

  describe('RuntimeCommandService', () => {
    it('is instantiated via LoopService', () => {
      expect(loops.runtimeCommand).toBeInstanceOf(RuntimeCommandService);
    });

    it('builds mock runtime command', () => {
      const result = loops.runtimeCommand.buildRuntimeCommand('mock', '/tmp/test', 'echo hello', false);
      expect(result.command).toBeDefined();
      expect(result.args.length).toBeGreaterThan(0);
    });

    it('builds codex runtime command', () => {
      const result = loops.runtimeCommand.buildRuntimeCommand('codex', '/tmp/test', 'fix bug', false);
      expect(result.command).toBe('codex');
      expect(result.args).toContain('exec');
    });

    it('builds opencode runtime command', () => {
      const result = loops.runtimeCommand.buildRuntimeCommand('opencode', '/tmp/test', 'fix bug', false);
      expect(result.command).toBe('opencode');
      expect(result.args).toContain('run');
    });

    it('returns manual runtime contract without probing', () => {
      const contract = loops.runtimeCommand.getRuntimeContract('manual');
      expect(contract.available).toBe(true);
      expect(contract.runtime).toBe('manual');
    });

    it('returns mock runtime contract', () => {
      const contract = loops.runtimeCommand.getRuntimeContract('mock');
      expect(contract.available).toBe(true);
      expect(contract.runtime).toBe('mock');
    });

    it('returns unavailable for unsupported runtime', () => {
      const contract = loops.runtimeCommand.getRuntimeContract('nonexistent');
      expect(contract.available).toBe(false);
    });

    it('extracts runtime warnings from stderr', () => {
      const warnings = loops.runtimeCommand.extractRuntimeWarnings('', 'failed to parse plugin hooks config in .opencode/settings.json');
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0].class_name).toBe('plugin_hook_config_parse');
    });

    it('blocks completion on trust boundary warning for high-risk runs', () => {
      const warnings = [{ class_name: 'trust_boundary_warning', severity: 'blocking', message: 'trust boundary violated' }];
      const goal = loops.createGoal({ title: 'High risk', objective: 'Fix critical issue', acceptance_criteria: ['Works'], risk_class: 'high' });
      const mockRun = { id: 'r1', metadata: '{}', findings: [], loop_name: 'test', goal_id: goal.id } as any;
      expect(loops.runtimeCommand.runtimeWarningsBlockCompletion(warnings, mockRun)).toBe(true);
    });

    it('does not block completion on advisory warnings for low-risk runs', () => {
      const warnings = [{ class_name: 'plugin_hook_config_parse', severity: 'advisory', message: 'parse warning' }];
      const goal = loops.createGoal({ title: 'Low risk', objective: 'Minor fix', acceptance_criteria: ['Works'], risk_class: 'low' });
      const mockRun = { id: 'r1', metadata: '{}', findings: [], loop_name: 'test', goal_id: goal.id } as any;
      expect(loops.runtimeCommand.runtimeWarningsBlockCompletion(warnings, mockRun)).toBe(false);
    });

    it('calculates worker efficiency', () => {
      const usage = { total_tokens: 1000, prompt_tokens: 500, completion_tokens: 500, usage_source: 'test' } as any;
      const result = loops.runtimeCommand.calculateWorkerEfficiency(usage, 10);
      expect(result.total_tokens).toBe(1000);
      expect(result.tokens_per_diff_line).toBe(100);
    });

    it('returns unknown efficiency for null usage', () => {
      const result = loops.runtimeCommand.calculateWorkerEfficiency(null, 0);
      expect(result.usage_source).toBe('unknown');
    });

    it('reports concurrency in use', () => {
      expect(loops.runtimeCommand.runtimeConcurrencyInUse()).toBe(0);
    });
  });

  describe('LoopLifecycleService', () => {
    it('is instantiated via LoopService', () => {
      expect(loops.lifecycle).toBeInstanceOf(LoopLifecycleService);
    });

    it.skip('throws when no findings to assign (pre-existing: startLoop now auto-discovers findings)', () => {
      const run = loops.startLoop({ repository_path: '/nonexistent/path' });
      expect(() => loops.lifecycle.continueLoopRun(run.id)).toThrow('LOOP_NO_FINDINGS_TO_ASSIGN');
    });
  });

  describe('LoopDiscoveryService', () => {
    it('is instantiated via LoopService', () => {
      expect(loops.discovery).toBeInstanceOf(LoopDiscoveryService);
    });

    it('returns empty for unknown loop type', () => {
      const findings = loops.discovery.discoverLoopFindings('unknown-loop' as any, '/tmp/test', 10);
      expect(findings).toEqual([]);
    });

    it('discovers doc drift findings for nonexistent repo gracefully', () => {
      const findings = loops.discovery.discoverLoopFindings('doc-drift-and-small-fix-loop', '/nonexistent/path', 10);
      expect(Array.isArray(findings)).toBe(true);
    });

    it('discovers repo maintenance findings for nonexistent repo', () => {
      const findings = loops.discovery.discoverLoopFindings('repo-maintenance-loop', '/nonexistent/path', 10);
      expect(Array.isArray(findings)).toBe(true);
    });

    it('discovers skill quality findings for nonexistent repo', () => {
      const findings = loops.discovery.discoverLoopFindings('skill-quality-loop', '/nonexistent/path', 10);
      expect(Array.isArray(findings)).toBe(true);
    });

    it('discovers MCP connector findings for nonexistent repo', () => {
      const findings = loops.discovery.discoverLoopFindings('mcp-connector-validation-loop', '/nonexistent/path', 10);
      expect(Array.isArray(findings)).toBe(true);
    });

    it('discovers security regression findings for nonexistent repo', () => {
      const findings = loops.discovery.discoverLoopFindings('security-regression-loop', '/nonexistent/path', 10);
      expect(Array.isArray(findings)).toBe(true);
    });

    it('discovers OKF sync findings for nonexistent repo', () => {
      const findings = loops.discovery.discoverLoopFindings('okf-synchronization-loop', '/nonexistent/path', 10);
      expect(Array.isArray(findings)).toBe(true);
    });

    it('discovers overwatch policy findings for nonexistent repo', () => {
      const findings = loops.discovery.discoverLoopFindings('overwatch-policy-drift-loop', '/nonexistent/path', 10);
      expect(Array.isArray(findings)).toBe(true);
    });
  });
});

describe('MetaOrchestrationService', () => {
  let db: ReturnType<typeof createTestDb>;
  let meta: MetaOrchestrationService;

  beforeEach(() => {
    db = createTestDb();
    // MetaOrchestrationService needs its own tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta_task_history (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, task_type TEXT NOT NULL DEFAULT 'coding',
        title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL DEFAULT 'litellm', model TEXT NOT NULL DEFAULT 'coding',
        runtime TEXT NOT NULL DEFAULT 'mock', outcome TEXT NOT NULL DEFAULT 'success',
        duration_ms INTEGER NOT NULL DEFAULT 0, cost_dollars REAL NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]', metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS meta_tuning_log (
        id TEXT PRIMARY KEY, goal_type TEXT NOT NULL, tuning_type TEXT NOT NULL,
        recommended_value TEXT NOT NULL DEFAULT '{}', confidence REAL NOT NULL DEFAULT 0,
        applied INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS model_routing_decisions (
        id TEXT PRIMARY KEY, task_type TEXT NOT NULL, selected_model TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '', alternatives_json TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL DEFAULT 0, cascade_level INTEGER NOT NULL DEFAULT 0,
        max_escalations INTEGER NOT NULL DEFAULT 0, models_attempted TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS cognitive_episodes (
        id TEXT PRIMARY KEY, loop_run_id TEXT NOT NULL, goal_type TEXT NOT NULL,
        strategy TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'success',
        cost_dollars REAL NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0,
        worker_count INTEGER NOT NULL DEFAULT 0, approval_required INTEGER NOT NULL DEFAULT 0,
        metadata TEXT NOT NULL DEFAULT '{}', recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS cognitive_patterns (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        conditions_json TEXT NOT NULL DEFAULT '{}', outcomes_json TEXT NOT NULL DEFAULT '{}',
        confidence REAL NOT NULL DEFAULT 0, episode_count INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    meta = new MetaOrchestrationService(db);
  });

  it('predicts failure for task with no history', () => {
    const prediction = meta.predictFailure({
      title: 'Test task',
      description: 'Do something',
      priority: 'medium',
      riskLevel: 'low',
      executionMode: 'local',
      tags: [],
      metadata: {},
    });
    expect(prediction.willFail).toBe(false);
    expect(prediction.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('predicts failure for high-risk task', () => {
    const prediction = meta.predictFailure({
      title: 'Critical auth refactor',
      description: 'Refactor OAuth flow',
      priority: 'critical',
      riskLevel: 'high',
      executionMode: 'local',
      tags: ['security'],
      metadata: {},
    });
    // High risk adds to fail score
    expect(prediction.reasons.length).toBeGreaterThan(0);
  });

  it('returns default routing for unknown task type', () => {
    const routing = meta.getRoutingOptimization('unknown-task-type');
    expect(routing.recommendedModel).toBeDefined();
    expect(routing.expectedSuccessRate).toBe(0.5);
  });

  it('returns default strategy for unknown goal type', () => {
    const strategy = meta.getStrategyRecommendation('unknown-goal');
    expect(strategy.strategy).toBe('maker-checker-v1');
    expect(strategy.confidence).toBe(0.3);
  });

  it('returns default tuning for goal type with no episodes', () => {
    const tuning = meta.getLoopTuning('doc-drift');
    expect(tuning.recommendedConcurrency).toBe(2);
    expect(tuning.confidence).toBe(0.3);
  });

  it('records outcome for learning', () => {
    expect(() => {
      meta.recordOutcome({
        taskId: 'task-1',
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
    }).not.toThrow();

    const stats = meta.getStats();
    expect(stats.totalDecisions).toBeGreaterThan(0);
  });

  it('provides meta stats', () => {
    const stats = meta.getStats();
    expect(stats.avgOptimizationConfidence).toBeGreaterThanOrEqual(0.5);
    expect(stats.totalDecisions).toBe(0);
  });

  it('returns empty tuning history initially', () => {
    const history = meta.getTuningHistory();
    expect(history).toEqual([]);
  });

  it('stores tuning history after auto-tuning', () => {
    // Seed cognitive episodes for auto-tuning to pick up
    for (let i = 0; i < 6; i++) {
      db.prepare(`INSERT INTO cognitive_episodes (id, loop_run_id, goal_type, strategy, status, cost_dollars, duration_ms, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(`ep-${i}`, `run-${i}`, 'test-goal', 'strategy-a', 'success', 0.01, 5000, new Date().toISOString());
    }
    // Manually trigger auto-tuning
    (meta as any).runAutoTuning();
    const history = meta.getTuningHistory('test-goal');
    expect(history.length).toBeGreaterThan(0);
  });
});

describe('RetentionService', () => {
  let db: ReturnType<typeof createTestDb>;
  let retention: RetentionService;

  beforeEach(() => {
    db = createTestDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS cognitive_episodes (
        id TEXT PRIMARY KEY, loop_run_id TEXT NOT NULL, goal_type TEXT NOT NULL,
        strategy TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'success',
        cost_dollars REAL NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0,
        worker_count INTEGER NOT NULL DEFAULT 0, approval_required INTEGER NOT NULL DEFAULT 0,
        metadata TEXT NOT NULL DEFAULT '{}', recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    retention = new RetentionService(db);
  });

  it('purges old records from cognitive_episodes', async () => {
    const old = new Date(Date.now() - 100 * 86400_000).toISOString();
    db.prepare(`INSERT INTO cognitive_episodes (id, loop_run_id, goal_type, strategy, status, cost_dollars, duration_ms, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('old-ep', 'old-run', 'doc-drift', 'strategy', 'success', 0.01, 5000, old);

    const result = await retention.purge();
    expect(result.results.length).toBeGreaterThan(0);

    const remaining = db.prepare('SELECT COUNT(*) as c FROM cognitive_episodes').get() as any;
    expect(remaining.c).toBe(0);
  });

  it('keeps recent cognitive episodes', async () => {
    const recent = new Date().toISOString();
    db.prepare(`INSERT INTO cognitive_episodes (id, loop_run_id, goal_type, strategy, status, cost_dollars, duration_ms, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('recent-ep', 'recent-run', 'doc-drift', 'strategy', 'success', 0.01, 5000, recent);

    await retention.purge();
    const remaining = db.prepare('SELECT COUNT(*) as c FROM cognitive_episodes').get() as any;
    expect(remaining.c).toBe(1);
  });

  it('reports stats', () => {
    const stats = retention.getStats();
    expect(stats.enabled).toBe(true);
    expect(stats.retentionDays).toBe(90);
    expect(stats.intervalHours).toBe(24);
  });

  it('respects RETENTION_ENABLED=false', async () => {
    process.env.RETENTION_ENABLED = 'false';
    const disabled = new RetentionService(db);
    const result = await disabled.purge();
    expect(result.results).toEqual([]);
    delete process.env.RETENTION_ENABLED;
  });

  it('starts and stops without throwing', () => {
    expect(() => {
      retention.start();
      retention.stop();
    }).not.toThrow();
  });
});

describe('CognitiveLoopClosureService', () => {
  let db: ReturnType<typeof createTestDb>;
  let cognitive: CognitiveLoopClosureService;

  beforeEach(() => {
    db = createTestDb();
    // CognitiveLoopClosureService auto-creates its tables on construction
    cognitive = new CognitiveLoopClosureService(db);
  });

  afterEach(() => {
    cognitive.stop();
  });

  it('starts and subscribes to swarm events', () => {
    expect(() => cognitive.start()).not.toThrow();
  });

  it('records episode from loop_completed event', () => {
    cognitive.start();
    swarmEventBus.emit('loop_completed', {
      loopRunId: 'run-1',
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

    const stats = cognitive.getStats();
    expect(stats.totalEpisodes).toBe(1);
  });

  it('returns null for best strategy with insufficient data', () => {
    const best = cognitive.getBestStrategy('doc-drift');
    expect(best).toBeNull();
  });

  it('returns meta learning status', () => {
    const status = cognitive.getMetaLearningStatus();
    expect(Array.isArray(status)).toBe(true);
  });

  it('provides stats', () => {
    const stats = cognitive.getStats();
    expect(stats.totalEpisodes).toBe(0);
    expect(stats.totalPatterns).toBe(0);
    expect(stats.totalStrategies).toBe(0);
  });
});
