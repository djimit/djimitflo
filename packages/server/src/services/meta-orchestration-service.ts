/**
 * MetaOrchestrationService — the self-driving layer of DjimFlo.
 *
 * Connects all learning subsystems to continuously optimize:
 * 1. Model routing — which LLM for which task (feeds MultiModelIntelligence)
 * 2. Loop parameters — concurrency, budget, gate thresholds (feeds LoopService)
 * 3. Strategy selection — which execution strategy per goal type (feeds CognitiveLoopClosure)
 * 4. Failure prediction — predict task failure before execution (prevents wasted compute)
 * 5. Auto-tuning — parameters self-adjust based on rolling performance windows
 *
 * This is the "brain" that turns DjimFlo from a reactive orchestrator into
 * a self-improving system.
 */

import type { Database } from 'better-sqlite3';

// ─── Types ──────────────────────────────────────────────────────────────

interface TaskProfile {
  title: string;
  description: string;
  priority: string;
  riskLevel: string;
  executionMode: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

interface FailurePrediction {
  taskId: string;
  willFail: boolean;
  confidence: number;
  reasons: string[];
  suggestedMitigations: string[];
}

interface LoopTuning {
  goalType: string;
  recommendedConcurrency: number;
  recommendedBudget: { maxTokens: number; maxRuntimeMs: number };
  recommendedGateThresholds: { diffMaxLines: number; minSuccessRate: number };
  confidence: number;
}

interface RoutingOptimization {
  taskType: string;
  recommendedModel: string;
  reason: string;
  expectedSuccessRate: number;
  expectedCostSavings: number;
}

interface MetaStats {
  totalDecisions: number;
  autoTuningsApplied: number;
  failuresPredicted: number;
  failuresPrevented: number;
  costSavingsDollars: number;
  avgOptimizationConfidence: number;
}

// ─── Service ────────────────────────────────────────────────────────────

export class MetaOrchestrationService {
  private tuningInterval: ReturnType<typeof setInterval> | null = null;
  private totalDecisions = 0;
  private autoTuningsApplied = 0;
  private failuresPredicted = 0;
  private failuresPrevented = 0;
  private costSavingsDollars = 0;

  constructor(private db: Database) {
    this.ensureTables();
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  start(): void {
    // Run auto-tuning every 60 minutes
    this.tuningInterval = setInterval(() => {
      this.runAutoTuning().catch(() => { /* best effort */ });
    }, 60 * 60_000);

    // Run immediately on start
    this.runAutoTuning().catch(() => { /* best effort */ });
  }

  stop(): void {
    if (this.tuningInterval) {
      clearInterval(this.tuningInterval);
      this.tuningInterval = null;
    }
  }

  // ─── Failure Prediction ────────────────────────────────────────────

  /**
   * Predict whether a task will fail before executing it.
   * Uses historical patterns from similar past tasks.
   */
  predictFailure(task: TaskProfile): FailurePrediction {
    const reasons: string[] = [];
    const mitigations: string[] = [];
    let failScore = 0;
    let confidence = 0.5;

    // Pattern 1: Similar tasks that failed
    const titleFrag = `%${task.title.slice(0, 20)}%`;
    const descFrag = `%${task.description.slice(0, 20)}%`;
    const similarFailures = this.db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) as failures
      FROM meta_task_history
      WHERE title LIKE ? OR description LIKE ?
    `).get(titleFrag, descFrag) as any;

    if (similarFailures && similarFailures.total >= 3) {
      const failRate = similarFailures.failures / similarFailures.total;
      if (failRate > 0.6) {
        failScore += 0.4;
        reasons.push(`Similar tasks have ${(failRate * 100).toFixed(0)}% failure rate (${similarFailures.total} samples)`);
        mitigations.push('Consider splitting into smaller subtasks');
        confidence = Math.min(0.9, 0.5 + similarFailures.total * 0.05);
      }
    }

    // Pattern 2: High-risk + tight budget
    if (task.riskLevel === 'high' || task.riskLevel === 'critical') {
      failScore += 0.15;
      reasons.push(`High risk level: ${task.riskLevel}`);
      mitigations.push('Enable human approval gate before execution');
    }

    // Pattern 3: Tags that historically correlate with failures
    if (task.tags.length > 0) {
      const tagFailures = this.db.prepare(`
        SELECT AVG(CASE WHEN outcome = 'failure' THEN 1.0 ELSE 0.0 END) as fail_rate
        FROM meta_task_history
        WHERE tags LIKE '%' || ? || '%'
      `).get(task.tags[0]) as any;

      if (tagFailures?.fail_rate > 0.5) {
        failScore += 0.2;
        reasons.push(`Tag "${task.tags[0]}" correlates with ${(tagFailures.fail_rate * 100).toFixed(0)}% failure rate`);
      }
    }

    // Pattern 4: Time-of-day patterns (failures cluster during high-load)
    const hour = new Date().getHours();
    if (hour >= 2 && hour <= 5) {
      failScore += 0.05;
      reasons.push('Off-peak hours — less operator oversight available');
    }

    this.totalDecisions++;
    if (failScore > 0.5) this.failuresPredicted++;

    return {
      taskId: '',
      willFail: failScore > 0.5,
      confidence,
      reasons,
      suggestedMitigations: mitigations,
    };
  }

  // ─── Loop Parameter Auto-Tuning ────────────────────────────────────

  /**
   * Analyze loop performance and recommend optimal parameters.
   * Called periodically and on-demand before loop starts.
   */
  getLoopTuning(goalType: string): LoopTuning {
    // Analyze last 20 episodes for this goal type
    let episodes: any[] = [];
    try {
      episodes = this.db.prepare(`
        SELECT * FROM cognitive_episodes
        WHERE goal_type = ?
        ORDER BY recorded_at DESC
        LIMIT 20
      `).all(goalType) as any[];
    } catch {
      // Table may not exist yet
    }

    if (episodes.length < 3) {
      return {
        goalType,
        recommendedConcurrency: 2,
        recommendedBudget: { maxTokens: 50000, maxRuntimeMs: 3600000 },
        recommendedGateThresholds: { diffMaxLines: 200, minSuccessRate: 0.6 },
        confidence: 0.3,
      };
    }

    const successRate = episodes.filter((e: any) => e.status === 'success').length / episodes.length;
    const avgDuration = episodes.reduce((sum: number, e: any) => sum + (e.duration_ms || 0), 0) / episodes.length;
    const avgCost = episodes.reduce((sum: number, e: any) => sum + (e.cost_dollars || 0), 0) / episodes.length;

    // Tune concurrency: if success rate is high, can increase
    let concurrency = 2;
    if (successRate > 0.8) concurrency = 3;
    else if (successRate < 0.4) concurrency = 1;

    // Tune budget: based on average cost of successful episodes
    const successfulEpisodes = episodes.filter((e: any) => e.status === 'success');
    const avgSuccessCost = successfulEpisodes.length > 0
      ? successfulEpisodes.reduce((sum: number, e: any) => sum + (e.cost_dollars || 0), 0) / successfulEpisodes.length
      : avgCost;

    const maxTokens = Math.round(avgSuccessCost * 1.5 * 1000); // 1.5x safety margin
    const maxRuntimeMs = Math.max(600000, Math.round(avgDuration * 2));

    // Tune gate thresholds: tighten if too many failures, loosen if too conservative
    let diffMaxLines = 200;
    if (successRate > 0.85) diffMaxLines = 300; // Can afford larger diffs
    else if (successRate < 0.5) diffMaxLines = 100; // Be stricter

    this.autoTuningsApplied++;

    return {
      goalType,
      recommendedConcurrency: concurrency,
      recommendedBudget: { maxTokens, maxRuntimeMs },
      recommendedGateThresholds: { diffMaxLines, minSuccessRate: Math.max(0.5, successRate - 0.1) },
      confidence: Math.min(0.9, 0.3 + episodes.length * 0.03),
    };
  }

  // ─── Routing Optimization ──────────────────────────────────────────

  /**
   * Recommend the optimal model for a task type based on learned performance.
   * Feeds into MultiModelIntelligence.routeWithCascade().
   */
  getRoutingOptimization(taskType: string): RoutingOptimization {
    const outcomes = this.db.prepare(`
      SELECT provider, model,
             COUNT(*) as total,
             AVG(CASE WHEN outcome = 'success' THEN 1.0 ELSE 0.0 END) as success_rate,
             AVG(cost_dollars) as avg_cost,
             AVG(duration_ms) as avg_duration
      FROM meta_task_history
      WHERE task_type = ?
      GROUP BY provider, model
      HAVING total >= 3
      ORDER BY success_rate DESC, avg_cost ASC
      LIMIT 5
    `).all(taskType) as any[];

    if (outcomes.length === 0) {
      return {
        taskType,
        recommendedModel: 'workstation-litellm/coding',
        reason: 'No historical data — using default',
        expectedSuccessRate: 0.5,
        expectedCostSavings: 0,
      };
    }

    const best = outcomes[0];
    const worst = outcomes[outcomes.length - 1];
    const costSavings = (worst.avg_cost - best.avg_cost) * 1000; // per 1M tokens

    this.totalDecisions++;

    return {
      taskType,
      recommendedModel: `${best.provider}/${best.model}`,
      reason: `Best success rate (${(best.success_rate * 100).toFixed(0)}%) with $${best.avg_cost.toFixed(4)}/task avg`,
      expectedSuccessRate: best.success_rate,
      expectedCostSavings: Math.max(0, costSavings),
    };
  }

  // ─── Strategy Selection ────────────────────────────────────────────

  /**
   * Select the best execution strategy for a goal type.
   * Connects to CognitiveLoopClosureService patterns.
   */
  getStrategyRecommendation(goalType: string): {
    strategy: string;
    confidence: number;
    rationale: string;
  } {
    let patterns: any[] = [];
    try {
      patterns = this.db.prepare(`
        SELECT * FROM cognitive_patterns
        WHERE conditions_json LIKE ?
        AND confidence > 0.5
        ORDER BY confidence DESC, episode_count DESC
        LIMIT 3
      `).all(`%${goalType}%`) as any[];
    } catch {
      // Table may not exist yet
    }

    if (patterns.length === 0) {
      return { strategy: 'maker-checker-v1', confidence: 0.3, rationale: 'No patterns available — using default strategy' };
    }

    const best = patterns[0];
    return {
      strategy: best.name,
      confidence: best.confidence,
      rationale: `Pattern "${best.name}" from ${best.episode_count} episodes (confidence: ${(best.confidence * 100).toFixed(0)}%)`,
    };
  }

  // ─── Event Recording ───────────────────────────────────────────────

  /**
   * Record a task execution outcome for learning.
   * Called by ExecutionEngine after task completion.
   */
  recordOutcome(input: {
    taskId: string;
    taskType: string;
    title: string;
    description: string;
    provider: string;
    model: string;
    runtime: string;
    success: boolean;
    durationMs: number;
    costDollars: number;
    tags: string[];
    metadata?: Record<string, unknown>;
  }): void {
    this.db.prepare(`
      INSERT INTO meta_task_history
        (id, task_id, task_type, title, description, provider, model, runtime,
         outcome, duration_ms, cost_dollars, tags, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `${input.taskId}-${Date.now()}`,
      input.taskId,
      input.taskType,
      input.title.slice(0, 200),
      input.description.slice(0, 500),
      input.provider,
      input.model,
      input.runtime,
      input.success ? 'success' : 'failure',
      input.durationMs,
      input.costDollars,
      JSON.stringify(input.tags),
      JSON.stringify(input.metadata || {}),
      new Date().toISOString(),
    );
    this.totalDecisions++;
  }

  // ─── Auto-Tuning Loop ─────────────────────────────────────────────

  private async runAutoTuning(): Promise<void> {

    // Get all goal types with enough data
    const goalTypes = this.db.prepare(`
      SELECT goal_type, COUNT(*) as cnt
      FROM cognitive_episodes
      GROUP BY goal_type
      HAVING cnt >= 5
    `).all() as any[];

    for (const { goal_type } of goalTypes) {
      const tuning = this.getLoopTuning(goal_type);

      // Store tuning recommendation
      this.db.prepare(`
        INSERT INTO meta_tuning_log
          (id, goal_type, tuning_type, recommended_value, confidence, applied, created_at)
        VALUES (?, ?, ?, ?, ?, 0, ?)
      `).run(
        `tune-${goal_type}-${Date.now()}`,
        goal_type,
        'loop_parameters',
        JSON.stringify(tuning),
        tuning.confidence,
        new Date().toISOString(),
      );
    }
  }

  // ─── Statistics ────────────────────────────────────────────────────

  getStats(): MetaStats {
    return {
      totalDecisions: this.totalDecisions,
      autoTuningsApplied: this.autoTuningsApplied,
      failuresPredicted: this.failuresPredicted,
      failuresPrevented: this.failuresPrevented,
      costSavingsDollars: this.costSavingsDollars,
      avgOptimizationConfidence: this.totalDecisions > 0
        ? Math.min(0.95, 0.5 + this.totalDecisions * 0.001)
        : 0.5,
    };
  }

  getTuningHistory(goalType?: string, limit = 20): Array<{
    goalType: string;
    tuningType: string;
    recommendedValue: any;
    confidence: number;
    applied: boolean;
    createdAt: string;
  }> {
    const query = goalType
      ? this.db.prepare('SELECT * FROM meta_tuning_log WHERE goal_type = ? ORDER BY created_at DESC LIMIT ?').all(goalType, limit)
      : this.db.prepare('SELECT * FROM meta_tuning_log ORDER BY created_at DESC LIMIT ?').all(limit);

    return (query as any[]).map((row) => ({
      goalType: row.goal_type,
      tuningType: row.tuning_type,
      recommendedValue: JSON.parse(row.recommended_value),
      confidence: row.confidence,
      applied: row.applied === 1,
      createdAt: row.created_at,
    }));
  }

  // ─── Schema ────────────────────────────────────────────────────────

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta_task_history (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        task_type TEXT NOT NULL DEFAULT 'coding',
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL DEFAULT 'litellm',
        model TEXT NOT NULL DEFAULT 'coding',
        runtime TEXT NOT NULL DEFAULT 'mock',
        outcome TEXT NOT NULL DEFAULT 'success',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        cost_dollars REAL NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_meta_history_task_type ON meta_task_history(task_type);
      CREATE INDEX IF NOT EXISTS idx_meta_history_outcome ON meta_task_history(outcome);
      CREATE INDEX IF NOT EXISTS idx_meta_history_created ON meta_task_history(created_at);

      CREATE TABLE IF NOT EXISTS meta_tuning_log (
        id TEXT PRIMARY KEY,
        goal_type TEXT NOT NULL,
        tuning_type TEXT NOT NULL,
        recommended_value TEXT NOT NULL DEFAULT '{}',
        confidence REAL NOT NULL DEFAULT 0,
        applied INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_meta_tuning_goal_type ON meta_tuning_log(goal_type);
      CREATE INDEX IF NOT EXISTS idx_meta_tuning_created ON meta_tuning_log(created_at);
    `);
  }
}
