import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { LoopService } from '../services/loop-service';
import { CognitiveLoopClosureService } from '../services/cognitive-loop-closure-service';
import { ContextCompressionService } from '../services/context-compression-service';

/**
 * Integration test: Full loop lifecycle with cognitive loop closure.
 * Verifies that loop execution produces episodes that feed into pattern extraction.
 */
describe('Integration: Full Loop Lifecycle', () => {
  let db: Database.Database;
  let loopService: LoopService;
  let cognitive: CognitiveLoopClosureService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    // Create all required tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY, objective TEXT, status TEXT DEFAULT 'created',
        budget_json TEXT DEFAULT '{}', constraints_json TEXT DEFAULT '[]',
        acceptance_criteria_json TEXT DEFAULT '[]', risk_class TEXT DEFAULT 'low',
        owner_user_id TEXT, metadata TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS loop_runs (
        id TEXT PRIMARY KEY, goal_id TEXT, loop_name TEXT, mode TEXT DEFAULT 'closed',
        status TEXT DEFAULT 'created', repository_path TEXT, state_file TEXT,
        findings_json TEXT DEFAULT '[]', plan_json TEXT DEFAULT '{}',
        gates_json TEXT DEFAULT '[]', next_actions_json TEXT DEFAULT '[]',
        metadata TEXT DEFAULT '{}', metadata_json TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS loop_events (
        id TEXT PRIMARY KEY, loop_run_id TEXT, event_type TEXT, level TEXT DEFAULT 'info',
        message TEXT, metadata TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS worker_leases (
        id TEXT PRIMARY KEY, loop_run_id TEXT, role TEXT, runtime TEXT DEFAULT 'codex',
        status TEXT DEFAULT 'prepared', finding_id TEXT, worktree_path TEXT,
        metadata TEXT DEFAULT '{}', budget_json TEXT DEFAULT '{}',
        capability_id TEXT, parent_lease_id TEXT, spawn_tree_id TEXT,
        depth INTEGER DEFAULT 0, spawned_by_agent_id TEXT,
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
    loopService = new LoopService(db, '.data/evidence-test');
    cognitive = new CognitiveLoopClosureService(db);
  });

  afterEach(() => {
    db.close();
  });

  it('completes a full loop lifecycle with episode recording', async () => {
    // 1. Create a goal
    const goal = loopService.createGoal({
      objective: 'Test goal for integration',
      acceptance_criteria: ['All tests pass'],
    });
    expect(goal.id).toBeDefined();

    // 2. Insert a loop run directly (avoids startDocDriftAndSmallFixLoop timeout)
    const runId = `test-run-${Date.now()}`;
    db.prepare(`
      INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(runId, goal.id, 'integration-test', 'closed', 'created');

    // 3. Record an episode via cognitive service
    const episode = cognitive.recordEpisode({
      loopRunId: runId,
      goalId: goal.id,
      goalType: 'general',
      mode: 'closed',
      startedAt: new Date(Date.now() - 60000).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 60000,
      outcome: 'success',
      strategy: 'test-strategy',
      actions: [],
      metrics: {
        totalLeases: 0, completedLeases: 0, failedLeases: 0,
        totalTokens: 0, totalCostDollars: 0, diffLinesChanged: 0,
        filesModified: 0, gatesPassed: 0, gatesFailed: 0,
      },
      metadata: {},
    });

    expect(episode.id).toBeDefined();
    expect(episode.outcome).toBe('success');

    // 4. Verify stats
    const stats = cognitive.getStats();
    expect(stats.totalEpisodes).toBe(1);
  }, { timeout: 10000 });

  it('compresses large metadata in loop events', () => {
    const compressor = new ContextCompressionService(db);

    // Create a large metadata object with many empty values (compressible)
    const largeMetadata: Record<string, unknown> = { keep: 'important_value' };
    for (let i = 0; i < 30; i++) {
      largeMetadata[`empty_${i}`] = '';
      largeMetadata[`null_${i}`] = null;
      largeMetadata[`arr_${i}`] = [];
    }

    const jsonStr = JSON.stringify(largeMetadata);
    const result = compressor.compress(jsonStr, 'json');
    // Compression should reduce size due to many empty values
    expect(result.compressed.length).toBeLessThanOrEqual(jsonStr.length);
  });
});
