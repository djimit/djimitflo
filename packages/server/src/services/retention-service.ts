/**
 * RetentionService — centralized data retention and purge scheduling.
 *
 * Manages lifecycle of ephemeral data across all services:
 * - Experience embeddings (ExperienceRetrievalService)
 * - Execution trajectories (TrajectoryStore)
 * - Vector memories (VectorMemoryService)
 * - Cognitive episodes & strategies (CognitiveLoopClosureService)
 *
 * Configured via:
 *   RETENTION_DAYS (default: 90) — global retention period
 *   RETENTION_ENABLED (default: true) — enable automatic purging
 *   RETENTION_RUN_ON_STARTUP (default: true) — purge on server start
 *   RETENTION_INTERVAL_HOURS (default: 24) — how often to run purge
 */

import type { Database } from 'better-sqlite3';

interface PurgeResult {
  table: string;
  deleted: number;
  cutoff: string;
}

interface RetentionStats {
  retentionDays: number;
  lastRun: string | null;
  totalPurged: number;
  results: PurgeResult[];
}

const DEFAULT_RETENTION_DAYS = 90;

export class RetentionService {
  private retentionDays: number;
  private enabled: boolean;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRun: string | null = null;
  private totalPurged = 0;

  constructor(private db: Database) {
    this.retentionDays = Number(process.env.RETENTION_DAYS) || DEFAULT_RETENTION_DAYS;
    this.enabled = process.env.RETENTION_ENABLED !== 'false';
    this.intervalMs = (Number(process.env.RETENTION_INTERVAL_HOURS) || 24) * 3600_000;
  }

  /**
   * Start the retention scheduler. Runs purge immediately if configured,
   * then schedules recurring purges.
   */
  start(): void {
    if (!this.enabled) return;

    if (process.env.RETENTION_RUN_ON_STARTUP !== 'false') {
      this.purge().catch(() => { /* best effort */ });
    }

    this.timer = setInterval(() => {
      this.purge().catch(() => { /* best effort */ });
    }, this.intervalMs);
  }

  /**
   * Stop the retention scheduler.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run purge across all managed tables.
   */
  async purge(): Promise<RetentionStats> {
    if (!this.enabled) {
      return { retentionDays: this.retentionDays, lastRun: this.lastRun, totalPurged: this.totalPurged, results: [] };
    }

    const cutoff = new Date(Date.now() - this.retentionDays * 86400_000).toISOString();
    const results: PurgeResult[] = [];

    // Experience embeddings
    results.push({
      table: 'experience_embeddings',
      deleted: this.deleteOlderThan('experience_embeddings', 'created_at', cutoff),
      cutoff,
    });

    // Trajectory steps
    results.push({
      table: 'trajectory_steps',
      deleted: this.deleteOlderThan('trajectory_steps', 'created_at', cutoff),
      cutoff,
    });

    // Vector memories (only those without explicit TTL)
    results.push({
      table: 'vector_memories',
      deleted: this.deleteOlderThan('vector_memories', 'created_at', cutoff, 'ttl IS NULL'),
      cutoff,
    });

    // Cognitive episodes
    results.push({
      table: 'cognitive_episodes',
      deleted: this.deleteOlderThan('cognitive_episodes', 'recorded_at', cutoff),
      cutoff,
    });

    // Cognitive patterns
    results.push({
      table: 'cognitive_patterns',
      deleted: this.deleteOlderThan('cognitive_patterns', 'last_seen_at', cutoff),
      cutoff,
    });

    // LLM provider metrics (keep shorter — 30 days)
    const metricsCutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
    results.push({
      table: 'llm_provider_metrics',
      deleted: this.deleteOlderThan('llm_provider_metrics', 'created_at', metricsCutoff),
      cutoff: metricsCutoff,
    });

    // Model routing decisions (keep shorter — 30 days)
    results.push({
      table: 'model_routing_decisions',
      deleted: this.deleteOlderThan('model_routing_decisions', 'created_at', metricsCutoff),
      cutoff: metricsCutoff,
    });

    // Model execution outcomes (keep shorter — 30 days)
    results.push({
      table: 'model_execution_outcomes',
      deleted: this.deleteOlderThan('model_execution_outcomes', 'created_at', metricsCutoff),
      cutoff: metricsCutoff,
    });

    const totalDeleted = results.reduce((sum, r) => sum + r.deleted, 0);
    this.totalPurged += totalDeleted;
    this.lastRun = new Date().toISOString();

    return {
      retentionDays: this.retentionDays,
      lastRun: this.lastRun,
      totalPurged: this.totalPurged,
      results,
    };
  }

  /**
   * Get retention statistics.
   */
  getStats(): {
    enabled: boolean;
    retentionDays: number;
    intervalHours: number;
    lastRun: string | null;
    totalPurged: number;
    nextRun: string | null;
  } {
    return {
      enabled: this.enabled,
      retentionDays: this.retentionDays,
      intervalHours: this.intervalMs / 3600_000,
      lastRun: this.lastRun,
      totalPurged: this.totalPurged,
      nextRun: this.lastRun
        ? new Date(new Date(this.lastRun).getTime() + this.intervalMs).toISOString()
        : null,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private deleteOlderThan(table: string, column: string, cutoff: string, extraWhere?: string): number {
    try {
      const where = extraWhere
        ? `WHERE ${column} < ? AND ${extraWhere}`
        : `WHERE ${column} < ?`;
      const result = this.db.prepare(`DELETE FROM ${table} ${where}`).run(cutoff);
      return result.changes;
    } catch {
      // Table may not exist yet
      return 0;
    }
  }
}
