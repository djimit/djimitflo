/**
 * TrajectoryStore — records execution trajectories for self-learning.
 *
 * Each loop run produces a trajectory: a sequence of steps (plan, execute, verify, fix)
 * with outcomes. These trajectories enable:
 * - Pattern extraction: "which action sequences lead to success?"
 * - Cross-task learning: trajectories from Task A inform Task B
 * - Failure analysis: "what went wrong at step N?"
 *
 * Activated when TRAJECTORY_BRIDGE_ENABLED=true.
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export type TrajectoryActionType = 'plan' | 'execute' | 'verify' | 'fix' | 'escalate' | 'complete';
export type TrajectoryOutcome = 'success' | 'failure' | 'skipped' | 'timeout';

export interface TrajectoryStep {
  id: string;
  runId: string;
  stepNumber: number;
  actionType: TrajectoryActionType;
  capabilityId: string | null;
  runtime: string;
  outcome: TrajectoryOutcome;
  durationMs: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface TrajectoryPattern {
  patternId: string;
  actionSequence: string;  // "plan→execute→fix→verify"
  occurrences: number;
  avgReward: number;
  description: string;
}

const TRAJECTORY_ENABLED = process.env.TRAJECTORY_BRIDGE_ENABLED === 'true';

export class TrajectoryStore {
  constructor(private db: Database) {
    this.ensureTables();
  }

  /**
   * Record a single trajectory step.
   */
  recordStep(input: {
    runId: string;
    actionType: TrajectoryActionType;
    capabilityId?: string | null;
    runtime?: string;
    outcome: TrajectoryOutcome;
    durationMs?: number;
    metadata?: Record<string, unknown>;
  }): TrajectoryStep | null {
    if (!TRAJECTORY_ENABLED) return null;

    const stepNumber = this.getNextStepNumber(input.runId);
    const step: TrajectoryStep = {
      id: randomUUID(),
      runId: input.runId,
      stepNumber,
      actionType: input.actionType,
      capabilityId: input.capabilityId || null,
      runtime: input.runtime || 'unknown',
      outcome: input.outcome,
      durationMs: input.durationMs || 0,
      metadata: input.metadata || {},
      createdAt: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT INTO trajectory_steps
      (id, run_id, step_number, action_type, capability_id, runtime, outcome, duration_ms, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      step.id, step.runId, step.stepNumber, step.actionType,
      step.capabilityId, step.runtime, step.outcome, step.durationMs,
      JSON.stringify(step.metadata), step.createdAt,
    );

    return step;
  }

  /**
   * Get the full trajectory for a run.
   */
  getTrajectory(runId: string): TrajectoryStep[] {
    const rows = this.db.prepare(
      'SELECT * FROM trajectory_steps WHERE run_id = ? ORDER BY step_number ASC'
    ).all(runId) as any[];
    return rows.map(this.rowToStep);
  }

  /**
   * Get a human-readable trajectory summary.
   */
  getTrajectorySummary(runId: string): string {
    const steps = this.getTrajectory(runId);
    if (steps.length === 0) return '_No trajectory recorded_';

    const parts: string[] = [];
    for (const step of steps) {
      const icon = step.outcome === 'success' ? '✓' : step.outcome === 'failure' ? '✗' : '○';
      parts.push(`${icon} ${step.actionType}(${step.runtime})`);
    }
    return parts.join(' → ');
  }

  /**
   * Find similar trajectories by action sequence pattern.
   */
  findSimilarTrajectories(actionSequence: string[], limit = 5): Array<{
    runId: string;
    outcome: TrajectoryOutcome;
    steps: TrajectoryStep[];
  }> {
    const placeholder = actionSequence.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT run_id, action_type, outcome
      FROM trajectory_steps
      WHERE run_id IN (
        SELECT run_id FROM trajectory_steps
        WHERE action_type IN (${placeholder})
        GROUP BY run_id
        HAVING COUNT(DISTINCT action_type) >= ?
      )
      ORDER BY run_id, step_number
    `).all(...actionSequence, Math.max(1, Math.floor(actionSequence.length * 0.7))) as any[];

    // Group by run_id
    const runMap = new Map<string, TrajectoryStep[]>();
    for (const row of rows) {
      const steps = runMap.get(row.run_id) || [];
      steps.push({ ...row, id: '', stepNumber: 0, capabilityId: null, runtime: '', durationMs: 0, metadata: {}, createdAt: '' });
      runMap.set(row.run_id, steps);
    }

    const results: Array<{ runId: string; outcome: TrajectoryOutcome; steps: TrajectoryStep[] }> = [];
    for (const [runId, steps] of runMap) {
      const lastStep = steps[steps.length - 1];
      results.push({ runId, outcome: lastStep?.outcome || 'skipped', steps });
    }

    return results.slice(0, limit);
  }

  /**
   * Extract success patterns from historical trajectories.
   */
  getSuccessPatterns(actionType: string, limit = 5): TrajectoryPattern[] {
    const rows = this.db.prepare(`
      SELECT t1.run_id,
             GROUP_CONCAT(t2.action_type, '→') as sequence,
             COUNT(*) as steps
      FROM trajectory_steps t1
      JOIN trajectory_steps t2 ON t1.run_id = t2.run_id
      WHERE t1.action_type = ?
        AND t1.outcome = 'success'
      GROUP BY t1.run_id
      ORDER BY steps DESC
      LIMIT ?
    `).all(actionType, limit) as any[];

    return rows.map((row, i) => ({
      patternId: `pattern-${i}`,
      actionSequence: row.sequence || '',
      occurrences: 1,
      avgReward: 1.0,
      description: `Success pattern starting with ${actionType}: ${row.sequence}`,
    }));
  }

  /**
   * Get trajectory statistics.
   */
  getStats(): {
    totalTrajectories: number;
    totalSteps: number;
    avgStepsPerRun: number;
    successRate: number;
    enabled: boolean;
  } {
    const totalSteps = (this.db.prepare('SELECT COUNT(*) as c FROM trajectory_steps').get() as any)?.c || 0;
    const totalRuns = (this.db.prepare('SELECT COUNT(DISTINCT run_id) as c FROM trajectory_steps').get() as any)?.c || 0;
    const successRuns = (this.db.prepare(`
      SELECT COUNT(DISTINCT run_id) as c FROM trajectory_steps
      WHERE step_number = (SELECT MAX(step_number) FROM trajectory_steps ts2 WHERE ts2.run_id = trajectory_steps.run_id)
      AND outcome = 'success'
    `).get() as any)?.c || 0;

    return {
      totalTrajectories: totalRuns,
      totalSteps,
      avgStepsPerRun: totalRuns > 0 ? Math.round(totalSteps / totalRuns) : 0,
      successRate: totalRuns > 0 ? Math.round((successRuns / totalRuns) * 100) : 0,
      enabled: TRAJECTORY_ENABLED,
    };
  }

  /**
   * Purge trajectories older than maxDays.
   */
  purgeOld(maxDays = Number(process.env.TRAJECTORY_RETENTION_DAYS) || 90): number {
    const cutoff = new Date(Date.now() - maxDays * 86400000).toISOString();
    const result = this.db.prepare('DELETE FROM trajectory_steps WHERE created_at < ?').run(cutoff);
    return result.changes;
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private getNextStepNumber(runId: string): number {
    const row = this.db.prepare(
      'SELECT MAX(step_number) as max_step FROM trajectory_steps WHERE run_id = ?'
    ).get(runId) as any;
    return (row?.max_step || 0) + 1;
  }

  private rowToStep(row: any): TrajectoryStep {
    return {
      id: row.id,
      runId: row.run_id,
      stepNumber: row.step_number,
      actionType: row.action_type,
      capabilityId: row.capability_id,
      runtime: row.runtime,
      outcome: row.outcome,
      durationMs: row.duration_ms,
      metadata: JSON.parse(row.metadata_json || '{}'),
      createdAt: row.created_at,
    };
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trajectory_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_number INTEGER NOT NULL,
        action_type TEXT NOT NULL CHECK(action_type IN ('plan', 'execute', 'verify', 'fix', 'escalate', 'complete')),
        capability_id TEXT,
        runtime TEXT NOT NULL DEFAULT 'unknown',
        outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure', 'skipped', 'timeout')),
        duration_ms INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_traj_run ON trajectory_steps(run_id);
      CREATE INDEX IF NOT EXISTS idx_traj_action ON trajectory_steps(action_type);
      CREATE INDEX IF NOT EXISTS idx_traj_outcome ON trajectory_steps(outcome);
      CREATE INDEX IF NOT EXISTS idx_traj_created ON trajectory_steps(created_at);
    `);
  }
}
