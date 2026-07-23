/**
 * ExperimentTrackingService — ML experiment tracking for DjimFlo.
 *
 * Tracks experiment runs, metrics, and artifacts.
 * Inspired by MLflow but lightweight and embedded.
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface ExperimentRun {
  run_id: string;
  experiment_name: string;
  status: 'running' | 'completed' | 'failed';
  params: Record<string, unknown>;
  metrics: Record<string, number>;
  artifacts: string[];
  started_at: string;
  completed_at?: string;
}

export interface MetricEntry {
  run_id: string;
  key: string;
  value: number;
  step: number;
  timestamp: string;
}

export class ExperimentTrackingService {
  constructor(private db: Database) {
    this.ensureTables();
  }

  /**
   * Start a new experiment run.
   */
  startRun(experimentName: string, params: Record<string, unknown> = {}): string {
    const run_id = `run-${randomUUID().slice(0, 8)}`;
    const started_at = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO experiment_runs (run_id, experiment_name, status, params, started_at)
      VALUES (?, ?, 'running', ?, ?)
    `).run(run_id, experimentName, JSON.stringify(params), started_at);

    return run_id;
  }

  /**
   * Log a metric value.
   */
  logMetric(runId: string, key: string, value: number, step = 0): void {
    this.db.prepare(`
      INSERT INTO experiment_metrics (run_id, metric_key, metric_value, step, timestamp)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(runId, key, value, step);

    // Update aggregated metrics
    const existing = this.db.prepare(
      'SELECT metrics FROM experiment_runs WHERE run_id = ?'
    ).get(runId) as any;

    const metrics = existing ? JSON.parse(existing.metrics || '{}') : {};
    metrics[key] = value;

    this.db.prepare('UPDATE experiment_runs SET metrics = ? WHERE run_id = ?')
      .run(JSON.stringify(metrics), runId);
  }

  /**
   * Log multiple metrics at once.
   */
  logMetrics(runId: string, metrics: Record<string, number>, step = 0): void {
    for (const [key, value] of Object.entries(metrics)) {
      this.logMetric(runId, key, value, step);
    }
  }

  /**
   * End an experiment run.
   */
  endRun(runId: string, status: 'completed' | 'failed' = 'completed'): void {
    this.db.prepare(
      "UPDATE experiment_runs SET status = ?, completed_at = datetime('now') WHERE run_id = ?"
    ).run(status, runId);
  }

  /**
   * Get a run by ID.
   */
  getRun(runId: string): ExperimentRun | null {
    const row = this.db.prepare('SELECT * FROM experiment_runs WHERE run_id = ?').get(runId) as any;
    if (!row) return null;

    return {
      run_id: row.run_id,
      experiment_name: row.experiment_name,
      status: row.status,
      params: JSON.parse(row.params || '{}'),
      metrics: JSON.parse(row.metrics || '{}'),
      artifacts: JSON.parse(row.artifacts || '[]'),
      started_at: row.started_at,
      completed_at: row.completed_at,
    };
  }

  /**
   * List all runs for an experiment.
   */
  listRuns(experimentName?: string): ExperimentRun[] {
    const query = experimentName
      ? 'SELECT * FROM experiment_runs WHERE experiment_name = ? ORDER BY started_at DESC'
      : 'SELECT * FROM experiment_runs ORDER BY started_at DESC';

    const rows = experimentName
      ? this.db.prepare(query).all(experimentName)
      : this.db.prepare(query).all();

    return rows.map((row: any) => ({
      run_id: row.run_id,
      experiment_name: row.experiment_name,
      status: row.status,
      params: JSON.parse(row.params || '{}'),
      metrics: JSON.parse(row.metrics || '{}'),
      artifacts: JSON.parse(row.artifacts || '[]'),
      started_at: row.started_at,
      completed_at: row.completed_at,
    }));
  }

  /**
   * Compare two runs.
   */
  compareRuns(runIdA: string, runIdB: string): { metrics_diff: Record<string, number>; params_diff: Record<string, unknown[]> } {
    const runA = this.getRun(runIdA);
    const runB = this.getRun(runIdB);

    if (!runA || !runB) {
      return { metrics_diff: {}, params_diff: {} };
    }

    const metricsDiff: Record<string, number> = {};
    const allKeys = new Set([...Object.keys(runA.metrics), ...Object.keys(runB.metrics)]);

    for (const key of allKeys) {
      const valA = runA.metrics[key] || 0;
      const valB = runB.metrics[key] || 0;
      metricsDiff[key] = valA - valB;
    }

    const paramsDiff: Record<string, unknown[]> = {};
    const allParamKeys = new Set([...Object.keys(runA.params), ...Object.keys(runB.params)]);

    for (const key of allParamKeys) {
      if (JSON.stringify(runA.params[key]) !== JSON.stringify(runB.params[key])) {
        paramsDiff[key] = [runA.params[key], runB.params[key]];
      }
    }

    return { metrics_diff: metricsDiff, params_diff: paramsDiff };
  }

  /**
   * Generate ASCII chart for a metric.
   */
  plotMetric(runIds: string[], metricKey: string): string {
    const lines: string[] = [`Metric: ${metricKey}`, ''];

    for (const runId of runIds) {
      const rows = this.db.prepare(
        'SELECT metric_value, step FROM experiment_metrics WHERE run_id = ? AND metric_key = ? ORDER BY step'
      ).all(runId, metricKey) as any[];

      if (rows.length === 0) continue;

      const values = rows.map(r => r.metric_value);
      const max = Math.max(...values);
      const min = Math.min(...values);
      const range = max - min || 1;

      lines.push(`Run: ${runId.slice(0, 12)}...`);
      for (let i = 0; i < values.length; i++) {
        const barLength = Math.round(((values[i] - min) / range) * 40);
        const bar = '█'.repeat(barLength) + '░'.repeat(40 - barLength);
        lines.push(`  ${i}: ${bar} ${values[i].toFixed(3)}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS experiment_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL UNIQUE,
        experiment_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed')),
        params TEXT NOT NULL DEFAULT '{}',
        metrics TEXT NOT NULL DEFAULT '{}',
        artifacts TEXT NOT NULL DEFAULT '[]',
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS experiment_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        metric_key TEXT NOT NULL,
        metric_value REAL NOT NULL,
        step INTEGER NOT NULL DEFAULT 0,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (run_id) REFERENCES experiment_runs(run_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_exp_metrics_run ON experiment_metrics(run_id);
      CREATE INDEX IF NOT EXISTS idx_exp_metrics_key ON experiment_metrics(metric_key);
      CREATE INDEX IF NOT EXISTS idx_exp_runs_experiment ON experiment_runs(experiment_name);
    `);
  }
}
