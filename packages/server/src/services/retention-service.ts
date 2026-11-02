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
import { markRun, noteScheduler } from './scheduler-registry';

/**
 * OBS-003: each table's outcome is explicit. 'missing' (no such table yet) is a known no-op; 'error' (lock, I/O,
 * schema) has deleted: null — never a zero that reads as "nothing to purge".
 */
type PurgeStatus = 'ok' | 'missing' | 'error';

interface PurgeResult {
  table: string;
  status: PurgeStatus;
  deleted: number | null;
  cutoff: string;
  error?: string;
}

interface RetentionStats {
  retentionDays: number;
  lastRun: string | null;
  /** 'error' when any table failed; null when disabled. */
  status: 'ok' | 'error' | null;
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
  private lastStatus: 'ok' | 'error' | null = null;
  private lastErrors: Array<{ table: string; error: string }> = [];
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
    if (!noteScheduler('retention', 'RETENTION_ENABLED', this.enabled, this.intervalMs)) return;

    // a failed table or a thrown purge reaches the scheduler registry as last_error (status 'failing'), not silence
    const tick = (): void => {
      this.purge().then(
        (r) => markRun('retention', r.status === 'error'
          ? new Error(`purge failed: ${this.lastErrors.map((e) => `${e.table}: ${e.error}`).join('; ')}`)
          : undefined),
        (e) => markRun('retention', e),
      );
    };
    if (process.env.RETENTION_RUN_ON_STARTUP !== 'false') tick();
    this.timer = setInterval(tick, this.intervalMs);
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
      return { retentionDays: this.retentionDays, lastRun: this.lastRun, status: null, totalPurged: this.totalPurged, results: [] };
    }

    const cutoff = new Date(Date.now() - this.retentionDays * 86400_000).toISOString();
    // LLM provider metrics, routing decisions and execution outcomes are kept shorter — 30 days
    const metricsCutoff = new Date(Date.now() - 30 * 86400_000).toISOString();

    const results: PurgeResult[] = [
      this.deleteOlderThan('experience_embeddings', 'created_at', cutoff),
      this.deleteOlderThan('trajectory_steps', 'created_at', cutoff),
      // Vector memories (only those without explicit TTL)
      this.deleteOlderThan('vector_memories', 'created_at', cutoff, 'ttl IS NULL'),
      this.deleteOlderThan('cognitive_episodes', 'recorded_at', cutoff),
      this.deleteOlderThan('cognitive_patterns', 'last_seen_at', cutoff),
      this.deleteOlderThan('llm_provider_metrics', 'created_at', metricsCutoff),
      this.deleteOlderThan('model_routing_decisions', 'created_at', metricsCutoff),
      this.deleteOlderThan('model_execution_outcomes', 'created_at', metricsCutoff),
    ];

    this.totalPurged += results.reduce((sum, r) => sum + (r.deleted ?? 0), 0);
    this.lastRun = new Date().toISOString();
    this.lastErrors = results.filter((r) => r.status === 'error').map((r) => ({ table: r.table, error: r.error ?? 'unknown' }));
    this.lastStatus = this.lastErrors.length ? 'error' : 'ok';

    return {
      retentionDays: this.retentionDays,
      lastRun: this.lastRun,
      status: this.lastStatus,
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
    lastStatus: 'ok' | 'error' | null;
    lastErrors: Array<{ table: string; error: string }>;
    totalPurged: number;
    nextRun: string | null;
  } {
    return {
      enabled: this.enabled,
      retentionDays: this.retentionDays,
      intervalHours: this.intervalMs / 3600_000,
      lastRun: this.lastRun,
      lastStatus: this.lastStatus,
      lastErrors: this.lastErrors,
      totalPurged: this.totalPurged,
      nextRun: this.lastRun
        ? new Date(new Date(this.lastRun).getTime() + this.intervalMs).toISOString()
        : null,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private deleteOlderThan(table: string, column: string, cutoff: string, extraWhere?: string): PurgeResult {
    try {
      const where = extraWhere
        ? `WHERE ${column} < ? AND ${extraWhere}`
        : `WHERE ${column} < ?`;
      const result = this.db.prepare(`DELETE FROM ${table} ${where}`).run(cutoff);
      return { table, status: 'ok', deleted: result.changes, cutoff };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      // only "no such table" is the known no-op (its owning service has not created it yet)
      if (/^no such table/i.test(error)) return { table, status: 'missing', deleted: 0, cutoff };
      return { table, status: 'error', deleted: null, cutoff, error: error.slice(0, 200) };
    }
  }
}
