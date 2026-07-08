/**
 * CognitiveLoopClosureService — cross-episode learning and strategy evolution.
 *
 * Transforms DjimFlo from a "dumb orchestrator" into a "learning system" by:
 * 1. Recording loop executions as structured episodes
 * 2. Extracting behavioral patterns from episode sequences
 * 3. Evolving strategies based on pattern success rates
 * 4. Applying learned strategies to future loop executions
 *
 * Architecture:
 *   Loop Execution → EpisodeRecorder → PatternExtractor → StrategyEvolver → MetaLearning
 *        ↑                                                                    │
 *        └──────────────────── Learned Strategy ◄──────────────────────────────┘
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { swarmEventBus } from './swarm-event-bus';

// ─── Types ────────────────────────────────────────────────────────────────

interface Episode {
  id: string;
  loopRunId: string;
  goalId: string;
  goalType: string;
  mode: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  outcome: 'success' | 'failure' | 'partial' | 'cancelled';
  strategy: string;
  actions: EpisodeAction[];
  metrics: EpisodeMetrics;
  metadata: Record<string, unknown>;
}

interface EpisodeAction {
  type: string;
  timestamp: string;
  details: Record<string, unknown>;
  result: 'success' | 'failure' | 'skipped';
}

interface EpisodeMetrics {
  totalLeases: number;
  completedLeases: number;
  failedLeases: number;
  totalTokens: number;
  totalCostDollars: number;
  diffLinesChanged: number;
  filesModified: number;
  gatesPassed: number;
  gatesFailed: number;
}

interface ExtractedPattern {
  id: string;
  name: string;
  description: string;
  conditions: Record<string, unknown>;
  outcomes: Record<string, number>;
  confidence: number;
  episodeCount: number;
  lastSeenAt: string;
}

interface Strategy {
  id: string;
  name: string;
  description: string;
  goalType: string;
  conditions: Record<string, unknown>;
  actions: StrategyAction[];
  successRate: number;
  episodeCount: number;
  avgDurationMs: number;
  avgCostDollars: number;
  lastUsedAt: string;
  createdAt: string;
}

interface StrategyAction {
  type: string;
  parameters: Record<string, unknown>;
  priority: number;
}

interface MetaLearningRecord {
  goalType: string;
  bestStrategy: string;
  bestSuccessRate: number;
  totalEpisodes: number;
  totalStrategies: number;
  lastUpdated: string;
}

// ─── Service ──────────────────────────────────────────────────────────────

export class CognitiveLoopClosureService {
  private unsubscribe: (() => void) | null = null;
  private episodeBuffer: Episode[] = [];
  private readonly BUFFER_FLUSH_SIZE = 5;

  constructor(private db: Database) {
    this.ensureTables();
  }

  /**
   * Start listening to loop events and recording episodes.
   */
  start(): void {
    if (this.unsubscribe) return;

    this.unsubscribe = swarmEventBus.subscribe((event) => {
      this.handleEvent(event);
    });
  }

  /**
   * Stop listening.
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /**
   * Record a loop execution episode.
   */
  recordEpisode(episode: Omit<Episode, 'id'>): Episode {
    const fullEpisode: Episode = { ...episode, id: randomUUID() };

    // Store in DB
    this.db.prepare(`
      INSERT INTO cognitive_episodes (
        id, loop_run_id, goal_id, goal_type, mode, started_at, completed_at,
        duration_ms, outcome, strategy, actions_json, metrics_json, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fullEpisode.id,
      fullEpisode.loopRunId,
      fullEpisode.goalId,
      fullEpisode.goalType,
      fullEpisode.mode,
      fullEpisode.startedAt,
      fullEpisode.completedAt,
      fullEpisode.durationMs,
      fullEpisode.outcome,
      fullEpisode.strategy,
      JSON.stringify(fullEpisode.actions),
      JSON.stringify(fullEpisode.metrics),
      JSON.stringify(fullEpisode.metadata),
    );

    // Buffer for pattern extraction
    this.episodeBuffer.push(fullEpisode);
    if (this.episodeBuffer.length >= this.BUFFER_FLUSH_SIZE) {
      this.extractPatterns();
      this.evolveStrategies();
    }

    return fullEpisode;
  }

  /**
   * Extract patterns from buffered episodes.
   */
  extractPatterns(): ExtractedPattern[] {
    if (this.episodeBuffer.length < 2) return [];

    const patterns: ExtractedPattern[] = [];
    const episodes = [...this.episodeBuffer];
    this.episodeBuffer = [];

    // Pattern 1: Goal type → outcome correlation
    const goalTypeOutcomes = this.groupBy(episodes, 'goalType');
    for (const [goalType, eps] of Object.entries(goalTypeOutcomes) as Array<[string, Episode[]]>) {
      const successRate = eps.filter((e) => e.outcome === 'success').length / eps.length;
      patterns.push({
        id: randomUUID(),
        name: `${goalType}_outcome_correlation`,
        description: `Goal type "${goalType}" has ${(successRate * 100).toFixed(0)}% success rate`,
        conditions: { goalType },
        outcomes: { success: successRate, failure: 1 - successRate },
        confidence: Math.min(1, eps.length / 10),
        episodeCount: eps.length,
        lastSeenAt: new Date().toISOString(),
      });
    }

    // Pattern 2: Strategy → outcome correlation (per goal type)
    const episodesByGoalType = this.groupBy(episodes, 'goalType');
    for (const [goalType, goalEps] of Object.entries(episodesByGoalType) as Array<[string, Episode[]]>) {
      const strategyOutcomes = this.groupBy(goalEps, 'strategy');
      for (const [strategy, eps] of Object.entries(strategyOutcomes) as Array<[string, Episode[]]>) {
        if (!strategy || strategy === 'default') continue;
        const successRate = eps.filter((e) => e.outcome === 'success').length / eps.length;
        const avgDuration = eps.reduce((sum, e) => sum + e.durationMs, 0) / eps.length;
        patterns.push({
          id: randomUUID(),
          name: `strategy_${strategy}_${goalType}_effectiveness`,
          description: `Strategy "${strategy}" for "${goalType}" → ${(successRate * 100).toFixed(0)}% success, avg ${Math.round(avgDuration / 1000)}s`,
          conditions: { strategy, goalType },
          outcomes: { success: successRate, avgDurationMs: avgDuration },
          confidence: Math.min(1, eps.length / 3),
          episodeCount: eps.length,
          lastSeenAt: new Date().toISOString(),
        });
      }
    }

    // Pattern 3: Duration → outcome anomaly
    const durations = episodes.map((e) => e.durationMs);
    const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
    const stdDev = Math.sqrt(durations.reduce((sum, d) => sum + (d - avgDuration) ** 2, 0) / durations.length);
    const anomalies = episodes.filter((e) => Math.abs(e.durationMs - avgDuration) > 2 * stdDev);
    if (anomalies.length > 0) {
      patterns.push({
        id: randomUUID(),
        name: 'duration_anomaly',
        description: `${anomalies.length} episodes with unusual duration (>${(avgDuration / 1000).toFixed(0)}s ± ${(stdDev / 1000).toFixed(0)}s)`,
        conditions: { avgDurationMs: avgDuration, stdDev },
        outcomes: { anomalyCount: anomalies.length, totalEpisodes: episodes.length },
        confidence: 0.7,
        episodeCount: anomalies.length,
        lastSeenAt: new Date().toISOString(),
      });
    }

    // Store patterns
    for (const pattern of patterns) {
      this.db.prepare(`
        INSERT OR REPLACE INTO cognitive_patterns (
          id, name, description, conditions_json, outcomes_json, confidence, episode_count, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        pattern.id,
        pattern.name,
        pattern.description,
        JSON.stringify(pattern.conditions),
        JSON.stringify(pattern.outcomes),
        pattern.confidence,
        pattern.episodeCount,
        pattern.lastSeenAt,
      );
    }

    return patterns;
  }

  /**
   * Evolve strategies based on extracted patterns.
   */
  evolveStrategies(): Strategy[] {
    const patterns = this.db.prepare(`
      SELECT * FROM cognitive_patterns WHERE confidence > 0.5 ORDER BY last_seen_at DESC LIMIT 20
    `).all() as Array<Record<string, unknown>>;

    const strategies: Strategy[] = [];

    for (const pattern of patterns) {
      const conditions = JSON.parse((pattern.conditions_json as string) || '{}');
      const outcomes = JSON.parse((pattern.outcomes_json as string) || '{}');

      // Only evolve strategies for high-confidence patterns
      if ((pattern.confidence as number) < 0.5) continue;

      const goalType = conditions.goalType as string || 'general';
      const strategyName = conditions.strategy as string || `learned_from_${pattern.name}`;

      // Check if strategy already exists
      const existing = this.db.prepare(`
        SELECT * FROM cognitive_strategies WHERE name = ? AND goal_type = ?
      `).get(strategyName, goalType) as any;

      const successRate = (outcomes.success as number) || 0;
      const episodeCount = (pattern.episode_count as number) || 0;

      if (existing) {
        // Update existing strategy
        const newSuccessRate = ((existing.success_rate * existing.episode_count) + (successRate * episodeCount)) / (existing.episode_count + episodeCount);
        this.db.prepare(`
          UPDATE cognitive_strategies
          SET success_rate = ?, episode_count = episode_count + ?, last_used_at = ?, avg_duration_ms = ?
          WHERE id = ?
        `).run(newSuccessRate, episodeCount, new Date().toISOString(), (outcomes.avgDurationMs as number) || 0, existing.id);
      } else {
        // Create new strategy
        const id = randomUUID();
        this.db.prepare(`
          INSERT INTO cognitive_strategies (
            id, name, description, goal_type, conditions_json, actions_json,
            success_rate, episode_count, avg_duration_ms, avg_cost_dollars, last_used_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          strategyName,
          `Auto-evolved from pattern: ${pattern.name}`,
          goalType,
          JSON.stringify(conditions),
          JSON.stringify([]),
          successRate,
          episodeCount,
          (outcomes.avgDurationMs as number) || 0,
          0,
          new Date().toISOString(),
          new Date().toISOString(),
        );

        strategies.push({
          id,
          name: strategyName,
          description: `Auto-evolved from pattern: ${pattern.name}`,
          goalType,
          conditions,
          actions: [],
          successRate,
          episodeCount,
          avgDurationMs: (outcomes.avgDurationMs as number) || 0,
          avgCostDollars: 0,
          lastUsedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        });
      }
    }

    // Update meta-learning records
    this.updateMetaLearning();

    return strategies;
  }

  /**
   * Get the best strategy for a given goal type.
   */
  getBestStrategy(goalType: string): Strategy | null {
    const row = this.db.prepare(`
      SELECT * FROM cognitive_strategies
      WHERE goal_type = ? AND episode_count >= 3
      ORDER BY success_rate DESC, episode_count DESC
      LIMIT 1
    `).get(goalType) as any;

    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      goalType: row.goal_type,
      conditions: JSON.parse(row.conditions_json || '{}'),
      actions: JSON.parse(row.actions_json || '[]'),
      successRate: row.success_rate,
      episodeCount: row.episode_count,
      avgDurationMs: row.avg_duration_ms,
      avgCostDollars: row.avg_cost_dollars,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
    };
  }

  /**
   * Get meta-learning status.
   */
  getMetaLearningStatus(): MetaLearningRecord[] {
    return (this.db.prepare('SELECT * FROM cognitive_meta_learning ORDER BY last_updated DESC').all() as any[]).map((row) => ({
      goalType: row.goal_type,
      bestStrategy: row.best_strategy,
      bestSuccessRate: row.best_success_rate,
      totalEpisodes: row.total_episodes,
      totalStrategies: row.total_strategies,
      lastUpdated: row.last_updated,
    }));
  }

  /**
   * Get cognitive loop statistics.
   */
  getStats(): {
    totalEpisodes: number;
    totalPatterns: number;
    totalStrategies: number;
    overallSuccessRate: number;
    bestGoalType: string | null;
  } {
    const episodes = (this.db.prepare('SELECT COUNT(*) as c FROM cognitive_episodes').get() as any)?.c || 0;
    const patterns = (this.db.prepare('SELECT COUNT(*) as c FROM cognitive_patterns').get() as any)?.c || 0;
    const strategies = (this.db.prepare('SELECT COUNT(*) as c FROM cognitive_strategies').get() as any)?.c || 0;

    const successRow = (this.db.prepare("SELECT AVG(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as rate FROM cognitive_episodes").get() as any);
    const bestGoal = (this.db.prepare("SELECT goal_type, AVG(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as rate FROM cognitive_episodes GROUP BY goal_type ORDER BY rate DESC LIMIT 1").get() as any);

    return {
      totalEpisodes: episodes,
      totalPatterns: patterns,
      totalStrategies: strategies,
      overallSuccessRate: successRow?.rate || 0,
      bestGoalType: bestGoal?.goal_type || null,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private handleEvent(event: { type: string; data?: Record<string, unknown> }): void {
    if (event.type === 'loop_completed' && event.data) {
      // Auto-record episode from loop completion event
      this.recordEpisodeFromEvent(event.data);
    }
  }

  private recordEpisodeFromEvent(data: Record<string, unknown>): void {
    const durationMs = Number(data.durationMs || 0);
    const outcome = this.inferOutcome(data);

    this.recordEpisode({
      loopRunId: String(data.loopRunId || randomUUID()),
      goalId: String(data.goalId || ''),
      goalType: String(data.goalType || 'general'),
      mode: String(data.mode || 'closed'),
      startedAt: String(data.startedAt || new Date(Date.now() - durationMs).toISOString()),
      completedAt: String(data.completedAt || new Date().toISOString()),
      durationMs,
      outcome,
      strategy: String(data.strategy || 'default'),
      actions: [],
      metrics: {
        totalLeases: Number(data.totalLeases || 0),
        completedLeases: Number(data.completedLeases || 0),
        failedLeases: Number(data.failedLeases || 0),
        totalTokens: Number(data.totalTokens || 0),
        totalCostDollars: Number(data.totalCostDollars || 0),
        diffLinesChanged: Number(data.diffLinesChanged || 0),
        filesModified: Number(data.filesModified || 0),
        gatesPassed: Number(data.gatesPassed || 0),
        gatesFailed: Number(data.gatesFailed || 0),
      },
      metadata: { source: 'event_bus', raw: data },
    });
  }

  private inferOutcome(data: Record<string, unknown>): 'success' | 'failure' | 'partial' | 'cancelled' {
    const status = String(data.status || '');
    if (status === 'completed') return 'success';
    if (status === 'failed') return 'failure';
    if (status === 'cancelled') return 'cancelled';
    if (status === 'escalated') return 'partial';
    return 'partial';
  }

  private updateMetaLearning(): void {
    const goalTypes = (this.db.prepare('SELECT DISTINCT goal_type FROM cognitive_strategies').all() as Array<{ goal_type: string }>);

    for (const { goal_type } of goalTypes) {
      const best = (this.db.prepare(`
        SELECT id, success_rate FROM cognitive_strategies
        WHERE goal_type = ? ORDER BY success_rate DESC LIMIT 1
      `).get(goal_type) as any);

      const totalEpisodes = (this.db.prepare('SELECT SUM(episode_count) as total FROM cognitive_strategies WHERE goal_type = ?').get(goal_type) as any)?.total || 0;
      const totalStrategies = (this.db.prepare('SELECT COUNT(*) as c FROM cognitive_strategies WHERE goal_type = ?').get(goal_type) as any)?.c || 0;

      this.db.prepare(`
        INSERT OR REPLACE INTO cognitive_meta_learning (
          goal_type, best_strategy, best_success_rate, total_episodes, total_strategies, last_updated
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        goal_type,
        best?.id || '',
        best?.success_rate || 0,
        totalEpisodes,
        totalStrategies,
        new Date().toISOString(),
      );
    }
  }

  private groupBy(items: Episode[], key: keyof Episode): Record<string, Episode[]> {
    return items.reduce((groups, item) => {
      const groupKey = String(item[key] || 'unknown');
      if (!groups[groupKey]) groups[groupKey] = [];
      groups[groupKey].push(item);
      return groups;
    }, {} as Record<string, Episode[]>);
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cognitive_episodes (
        id TEXT PRIMARY KEY,
        loop_run_id TEXT NOT NULL,
        goal_id TEXT,
        goal_type TEXT NOT NULL DEFAULT 'general',
        mode TEXT NOT NULL DEFAULT 'closed',
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        outcome TEXT NOT NULL DEFAULT 'partial' CHECK(outcome IN ('success', 'failure', 'partial', 'cancelled')),
        strategy TEXT NOT NULL DEFAULT 'default',
        actions_json TEXT NOT NULL DEFAULT '[]',
        metrics_json TEXT NOT NULL DEFAULT '{}',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_cognitive_episodes_goal_type ON cognitive_episodes(goal_type);
      CREATE INDEX IF NOT EXISTS idx_cognitive_episodes_outcome ON cognitive_episodes(outcome);
      CREATE INDEX IF NOT EXISTS idx_cognitive_episodes_strategy ON cognitive_episodes(strategy);

      CREATE TABLE IF NOT EXISTS cognitive_patterns (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        conditions_json TEXT NOT NULL DEFAULT '{}',
        outcomes_json TEXT NOT NULL DEFAULT '{}',
        confidence REAL NOT NULL DEFAULT 0 CHECK(confidence >= 0 AND confidence <= 1),
        episode_count INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS cognitive_strategies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        goal_type TEXT NOT NULL DEFAULT 'general',
        conditions_json TEXT NOT NULL DEFAULT '{}',
        actions_json TEXT NOT NULL DEFAULT '[]',
        success_rate REAL NOT NULL DEFAULT 0 CHECK(success_rate >= 0 AND success_rate <= 1),
        episode_count INTEGER NOT NULL DEFAULT 0,
        avg_duration_ms INTEGER NOT NULL DEFAULT 0,
        avg_cost_dollars REAL NOT NULL DEFAULT 0,
        last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_cognitive_strategies_goal_type ON cognitive_strategies(goal_type);
      CREATE INDEX IF NOT EXISTS idx_cognitive_strategies_success_rate ON cognitive_strategies(success_rate);

      CREATE TABLE IF NOT EXISTS cognitive_meta_learning (
        goal_type TEXT PRIMARY KEY,
        best_strategy TEXT NOT NULL DEFAULT '',
        best_success_rate REAL NOT NULL DEFAULT 0,
        total_episodes INTEGER NOT NULL DEFAULT 0,
        total_strategies INTEGER NOT NULL DEFAULT 0,
        last_updated TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
}
