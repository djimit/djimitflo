/**
 * CognitiveLoopClosureService — cross-episode learning and strategy evolution.
 *
 * Materializes observational learning evidence by:
 * 1. Recording loop executions as structured episodes
 * 2. Extracting behavioral patterns from episode sequences
 * 3. Evolving strategies based on pattern success rates
 * 4. Publishing observational strategy advice (not automatic application or causality)
 *
 * Architecture:
 *   Loop Execution → Durable Episodes → Patterns → Advisory Strategies
 * Strategy actions are not applied by the dispatcher; this is not a closed
 * improvement loop or evidence that future task outcomes improve.
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
  actions: Array<StrategyAction | string>;
  successRate: number;
  episodeCount: number;
  avgDurationMs: number;
  avgCostDollars: number;
  lastUsedAt: string | null;
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

  constructor(private db: Database) {
    this.ensureTables();
  }

  ingestLearning(input: {
    id: string;
    category: string;
    lesson: string;
    effectiveness: number;
    timesApplied: number;
    goalType?: string;
    strategy?: string;
  }): { patternId: string; strategies: Strategy[] } {
    const confidence = Math.max(0, Math.min(input.effectiveness / 100, 1));
    const episodeCount = Math.max(1, input.timesApplied);
    this.db.prepare(`
      INSERT OR REPLACE INTO cognitive_patterns (
        id, name, description, conditions_json, outcomes_json, confidence, episode_count, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      `learning_${input.id}`,
      input.lesson,
      JSON.stringify({
        goalType: input.goalType || input.category,
        strategy: input.strategy || `lesson_${input.category}`,
        lesson: input.lesson,
        evidence_basis: 'self_reported',
        causal_support: false,
      }),
      JSON.stringify({ success: confidence }),
      confidence,
      episodeCount,
      new Date().toISOString(),
    );
    return { patternId: input.id, strategies: this.evolveStrategies() };
  }

  /**
   * Start listening to loop events and recording episodes.
   */
  start(): void {
    if (this.unsubscribe) return;
    // Repair persisted projections from older batching/statistics implementations
    // using existing durable observations before publishing current advice.
    this.evolveStrategies();

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
    return this.db.transaction(() => {
    // A repeated delivery (including another service listener) is not replication.
    const existing = this.db.prepare('SELECT * FROM cognitive_episodes WHERE loop_run_id = ? ORDER BY rowid LIMIT 1').get(episode.loopRunId) as any;
    if (existing) return this.mapEpisode(existing);
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

    // Current strategy/meta readers must include every newly committed outcome;
    // a global batch boundary can leave an individual cohort permanently stale.
    // Full-history reconstruction is intentionally simple; scale is not benchmarked.
    this.evolveStrategies();

    return fullEpisode;
    }).immediate();
  }

  /**
   * Reconstruct current observational patterns from distinct durable loop outcomes.
   */
  extractPatterns(): ExtractedPattern[] {
    const episodes = this.readEpisodes();
    if (episodes.length < 2) return [];
    const patterns: ExtractedPattern[] = [];

    // Pattern 1: Goal type → outcome correlation
    const goalTypeOutcomes = this.groupBy(episodes, 'goalType');
    for (const [goalType, eps] of Object.entries(goalTypeOutcomes) as Array<[string, Episode[]]>) {
      const successRate = eps.filter((e) => e.outcome === 'success').length / eps.length;
      patterns.push({
        id: randomUUID(),
        name: `${goalType}_outcome_correlation`,
        description: `Goal type "${goalType}" has ${(successRate * 100).toFixed(0)}% success rate`,
        conditions: { goalType, evidence_basis: 'recorded_outcomes', confidence_basis: 'sample_count_heuristic', causal_support: false },
        outcomes: { success: successRate, failure: 1 - successRate },
        confidence: Math.min(1, eps.length / 10),
        episodeCount: eps.length,
        lastSeenAt: eps.map(e => e.completedAt).sort().at(-1)!,
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
          conditions: { strategy, goalType, evidence_basis: 'recorded_outcomes', confidence_basis: 'sample_count_heuristic', causal_support: false },
          outcomes: { success: successRate, avgDurationMs: avgDuration, avgCostDollars: eps.reduce((sum, e) => sum + e.metrics.totalCostDollars, 0) / eps.length },
          confidence: Math.min(1, eps.length / 3),
          episodeCount: eps.length,
          lastSeenAt: eps.map(e => e.completedAt).sort().at(-1)!,
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
      const existing = this.db.prepare('SELECT id FROM cognitive_patterns WHERE name = ?').get(pattern.name) as { id: string } | undefined;
      pattern.id = existing?.id ?? pattern.id;
      this.db.prepare(`
        INSERT INTO cognitive_patterns (
          id, name, description, conditions_json, outcomes_json, confidence, episode_count, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET description=excluded.description,
          conditions_json=excluded.conditions_json, outcomes_json=excluded.outcomes_json,
          confidence=excluded.confidence, episode_count=excluded.episode_count,
          last_seen_at=excluded.last_seen_at
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
    return this.db.transaction(() => {
    this.extractPatterns();
    const patterns = this.db.prepare(`
      SELECT * FROM cognitive_patterns ORDER BY last_seen_at DESC, id
    `).all() as Array<Record<string, unknown>>;

    const strategies: Strategy[] = [];
    const groups = new Map<string, Array<{ pattern: Record<string, unknown>; conditions: Record<string, any>; outcomes: Record<string, number> }>>();
    for (const pattern of patterns) {
      const conditions = JSON.parse((pattern.conditions_json as string) || '{}');
      const outcomes = JSON.parse((pattern.outcomes_json as string) || '{}');
      // An anomaly count without a success metric is not a zero-success strategy.
      if (!Number.isFinite(outcomes.success) || !(Number(pattern.episode_count) > 0)) continue;
      const goalType = conditions.goalType as string || 'general';
      const strategyName = conditions.strategy as string || `learned_from_${pattern.name}`;
      const key = JSON.stringify([goalType, strategyName]);
      const group = groups.get(key) ?? [];
      group.push({ pattern, conditions, outcomes });
      groups.set(key, group);
    }

    for (const [key, group] of groups) {
      const [goalType, strategyName] = JSON.parse(key) as [string, string];
      const observed = group.filter(item => item.conditions.evidence_basis === 'recorded_outcomes');
      const strategyObserved = observed.filter(item => item.conditions.strategy === strategyName);
      // Never blend a sender's effectiveness claim into measured loop outcomes.
      // Goal aggregates include these same episodes. If their generated advice
      // name equals a real strategy name, use its explicit cohort, never both.
      const evidence = strategyObserved.length ? strategyObserved : observed.length ? observed : group;
      const episodeCount = evidence.reduce((sum, item) => sum + Number(item.pattern.episode_count), 0);
      const weighted = (field: string) => evidence.reduce((sum, item) => sum + (Number(item.outcomes[field]) || 0) * Number(item.pattern.episode_count), 0) / episodeCount;
      const successRate = weighted('success');
      const avgDurationMs = weighted('avgDurationMs');
      const avgCostDollars = weighted('avgCostDollars');
      const conditions = { ...evidence[0].conditions, evidence_basis: observed.length ? 'recorded_outcomes' : 'self_reported', causal_support: false, selection_eligible: evidence.some(item => Number(item.pattern.confidence) > 0.5), pattern_ids: group.map(item => item.pattern.id) };
      const actions = [...new Set(group.flatMap(item => typeof item.conditions.lesson === 'string' ? [item.conditions.lesson] : []))];
      const lastUsedAt = observed.filter(item => item.conditions.strategy === strategyName).map(item => String(item.pattern.last_seen_at)).sort().at(-1) ?? null;
      // Existing NOT NULL storage uses an absence sentinel; API null is not a
      // fabricated strategy-use timestamp for newly imported advisory lessons.
      const storedLastUsedAt = lastUsedAt ?? '';
      const description = `Observational advice from ${group.map(item => item.pattern.name).join(', ')}`;

      // Check if strategy already exists
      const existing = this.db.prepare(`
        SELECT * FROM cognitive_strategies WHERE name = ? AND goal_type = ?
      `).get(strategyName, goalType) as any;

      if (existing) {
        // Replace the projection; replaying the same evidence cannot increase N.
        this.db.prepare(`
          UPDATE cognitive_strategies
          SET success_rate = ?, episode_count = ?, last_used_at = ?, avg_duration_ms = ?,
            avg_cost_dollars = ?, conditions_json = ?, actions_json = ?, description = ?
          WHERE id = ?
        `).run(successRate, episodeCount, storedLastUsedAt, avgDurationMs, avgCostDollars, JSON.stringify(conditions), JSON.stringify(actions), description, existing.id);
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
          description,
          goalType,
          JSON.stringify(conditions),
          JSON.stringify(actions),
          successRate,
          episodeCount,
          avgDurationMs,
          avgCostDollars,
          storedLastUsedAt,
          new Date().toISOString(),
        );

        strategies.push({
          id,
          name: strategyName,
          description,
          goalType,
          conditions,
          actions,
          successRate,
          episodeCount,
          avgDurationMs,
          avgCostDollars,
          lastUsedAt,
          createdAt: new Date().toISOString(),
        });
      }
    }

    // Update meta-learning records
    this.updateMetaLearning();

    return strategies;
    })();
  }

  /**
   * Get the best strategy for a given goal type.
   */
  getBestStrategy(goalType: string): Strategy | null {
    const row = this.db.prepare(`
      SELECT * FROM cognitive_strategies
      WHERE goal_type = ? AND episode_count >= 3
        AND COALESCE(json_extract(conditions_json, '$.selection_eligible'), 1) = 1
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
      lastUsedAt: row.last_used_at || null,
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
    const episodes = this.readEpisodes();
    const patterns = (this.db.prepare('SELECT COUNT(*) as c FROM cognitive_patterns').get() as any)?.c || 0;
    const strategies = (this.db.prepare('SELECT COUNT(*) as c FROM cognitive_strategies').get() as any)?.c || 0;

    const byGoal = this.groupBy(episodes, 'goalType');
    const bestGoal = Object.entries(byGoal).sort(([, a], [, b]) => b.filter(e => e.outcome === 'success').length / b.length - a.filter(e => e.outcome === 'success').length / a.length)[0]?.[0];

    return {
      totalEpisodes: episodes.length,
      totalPatterns: patterns,
      totalStrategies: strategies,
      overallSuccessRate: episodes.length ? episodes.filter(e => e.outcome === 'success').length / episodes.length : 0,
      bestGoalType: bestGoal || null,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private mapEpisode(row: any): Episode {
    return { id: row.id, loopRunId: row.loop_run_id, goalId: row.goal_id, goalType: row.goal_type,
      mode: row.mode, startedAt: row.started_at, completedAt: row.completed_at,
      durationMs: row.duration_ms, outcome: row.outcome, strategy: row.strategy,
      actions: JSON.parse(row.actions_json || '[]'), metrics: JSON.parse(row.metrics_json || '{}'),
      metadata: JSON.parse(row.metadata_json || '{}') };
  }

  private readEpisodes(): Episode[] {
    // Keep historical duplicates intact, but never count redelivery as replication.
    return (this.db.prepare(`SELECT * FROM cognitive_episodes WHERE rowid IN
      (SELECT MIN(rowid) FROM cognitive_episodes GROUP BY loop_run_id) ORDER BY rowid`).all() as any[])
      .map(row => this.mapEpisode(row));
  }

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
        WHERE goal_type = ? AND episode_count >= 3
          AND COALESCE(json_extract(conditions_json, '$.selection_eligible'), 1) = 1
        ORDER BY success_rate DESC LIMIT 1
      `).get(goal_type) as any);

      // Goal and strategy patterns overlap; their counts must never be summed.
      const totalEpisodes = this.readEpisodes().filter(episode => episode.goalType === goal_type).length;
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
