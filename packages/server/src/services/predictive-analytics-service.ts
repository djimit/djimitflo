/**
 * PredictiveAnalyticsService — predict loop outcomes from historical data.
 *
 * Uses historical loop execution data to predict:
 * 1. Success probability for new loops
 * 2. Expected duration and cost
 * 3. Risk factors and mitigation strategies
 * 4. Optimal agent/runtime selection
 *
 * Architecture:
 *   Historical Data → Feature Extraction → Prediction → Recommendation
 */

import type { Database } from 'better-sqlite3';

interface Prediction {
  loopRunId?: string;
  successProbability: number;
  expectedDurationMs: number;
  expectedCostDollars: number;
  riskFactors: string[];
  recommendations: string[];
  confidence: number;
}

interface HistoricalPattern {
  pattern: string;
  frequency: number;
  successRate: number;
  avgDurationMs: number;
}

export class PredictiveAnalyticsService {
  constructor(private db: Database) {}

  /**
   * Predict outcome for a new loop based on historical data.
   */
  predict(input: {
    goalType: string;
    runtime: string;
    mode: string;
    estimatedFindings?: number;
  }): Prediction {
    const historical = this.getHistoricalData(input.goalType || '', input.runtime || '', input.mode || '');

    // Calculate success probability
    const successRate = historical.length > 0
      ? historical.filter((h) => h.status === 'completed').length / historical.length
      : 0.5;

    // Calculate expected duration
    const completedRuns = historical.filter((h) => h.status === 'completed' && h.durationMs > 0);
    const avgDuration = completedRuns.length > 0
      ? completedRuns.reduce((sum, h) => sum + h.durationMs, 0) / completedRuns.length
      : 600000; // Default 10 minutes

    // Calculate expected cost
    const avgCost = completedRuns.length > 0
      ? completedRuns.reduce((sum, h) => sum + h.totalCost, 0) / completedRuns.length
      : 0.05;

    // Identify risk factors
    const riskFactors = this.identifyRiskFactors(input, historical);

    // Generate recommendations
    const recommendations = this.generateRecommendations(input, historical, riskFactors, successRate);

    // Calculate confidence based on data availability
    const confidence = Math.min(0.9, historical.length / 10);

    return {
      successProbability: successRate,
      expectedDurationMs: Math.round(avgDuration),
      expectedCostDollars: Math.round(avgCost * 100) / 100,
      riskFactors,
      recommendations,
      confidence,
    };
  }

  /**
   * Analyze historical patterns.
   */
  analyzePatterns(): HistoricalPattern[] {
    const patterns: HistoricalPattern[] = [];

    // Pattern by goal type
    const goalTypes = this.db.prepare(`
      SELECT json_extract(metadata, '$.goal_type') as goal_type, COUNT(*) as count
      FROM loop_runs
      WHERE metadata IS NOT NULL
      GROUP BY goal_type
    `).all() as any[];

    for (const gt of goalTypes) {
      if (!gt.goal_type) continue;
      const stats = this.db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successes,
          AVG(CASE WHEN completed_at IS NOT NULL THEN (julianday(completed_at) - julianday(created_at)) * 86400000 ELSE NULL END) as avg_duration
        FROM loop_runs
        WHERE json_extract(metadata, '$.goal_type') = ?
      `).get(gt.goal_type) as any;

      patterns.push({
        pattern: `goal_type:${gt.goal_type}`,
        frequency: stats.total || 0,
        successRate: stats.total > 0 ? (stats.successes || 0) / stats.total : 0,
        avgDurationMs: stats.avg_duration || 0,
      });
    }

    // Pattern by runtime
    const runtimes = this.db.prepare(`
      SELECT runtime, COUNT(*) as count
      FROM worker_leases
      GROUP BY runtime
    `).all() as any[];

    for (const rt of runtimes) {
      const stats = this.db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successes
        FROM worker_leases
        WHERE runtime = ?
      `).get(rt.runtime) as any;

      patterns.push({
        pattern: `runtime:${rt.runtime}`,
        frequency: stats.total || 0,
        successRate: stats.total > 0 ? (stats.successes || 0) / stats.total : 0,
        avgDurationMs: 0,
      });
    }

    return patterns.sort((a, b) => b.frequency - a.frequency);
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalPredictions: number;
    avgSuccessRate: number;
    totalPatterns: number;
    dataPoints: number;
  } {
    const loops = (this.db.prepare('SELECT COUNT(*) as c FROM loop_runs').get() as any)?.c || 0;
    const completed = (this.db.prepare("SELECT COUNT(*) as c FROM loop_runs WHERE status = 'completed'").get() as any)?.c || 0;
    const patterns = this.analyzePatterns();

    return {
      totalPredictions: loops,
      avgSuccessRate: loops > 0 ? completed / loops : 0,
      totalPatterns: patterns.length,
      dataPoints: loops,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private getHistoricalData(goalType: string, runtime: string, mode: string): Array<{
    status: string;
    durationMs: number;
    totalCost: number;
  }> {
    // Get historical loops with similar characteristics
    const runs = this.db.prepare(`
      SELECT
        lr.status,
        CASE WHEN lr.completed_at IS NOT NULL
          THEN (julianday(lr.completed_at) - julianday(lr.created_at)) * 86400000
          ELSE NULL END as duration_ms,
        COALESCE((
          SELECT SUM(COALESCE(
            json_extract(wl.metadata, '$.runtime_usage.total_tokens'),
            json_extract(wl.metadata, '$.total_tokens'),
            0
          ))
          FROM worker_leases wl
          WHERE wl.loop_run_id = lr.id
        ), 0) as total_tokens
      FROM loop_runs lr
      WHERE (? = '' OR json_extract(lr.metadata, '$.goal_type') = ?)
        AND (? = '' OR lr.mode = ?)
        AND (? = '' OR EXISTS (
          SELECT 1 FROM worker_leases runtime_lease
          WHERE runtime_lease.loop_run_id = lr.id AND runtime_lease.runtime = ?
        ))
      ORDER BY lr.created_at DESC
      LIMIT 100
    `).all(goalType, goalType, mode, mode, runtime, runtime) as any[];



    return runs.map((r) => ({
      status: r.status,
      durationMs: r.duration_ms || 0,
      totalCost: (r.total_tokens || 0) / 1000000 * 2, // $2/Mtok estimate
    }));
  }

  private identifyRiskFactors(input: {
    goalType: string;
    runtime: string;
  }, historical: Array<{ status: string; durationMs: number }>): string[] {
    const risks: string[] = [];

    // Low historical success rate for this runtime
    const runtimeSuccess = historical.filter((h) => h.status === 'completed').length / Math.max(1, historical.length);
    if (runtimeSuccess < 0.5) {
      risks.push(`Low historical success rate for runtime ${input.runtime}: ${(runtimeSuccess * 100).toFixed(0)}%`);
    }

    // High variance in duration
    const durations = historical.filter((h) => h.durationMs > 0).map((h) => h.durationMs);
    if (durations.length > 2) {
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      const variance = durations.reduce((sum, d) => sum + (d - avg) ** 2, 0) / durations.length;
      const cv = Math.sqrt(variance) / avg;
      if (cv > 0.5) {
        risks.push(`High duration variance (CV=${cv.toFixed(2)}) — predictions unreliable`);
      }
    }

    // Insufficient data
    if (historical.length < 5) {
      risks.push(`Insufficient historical data (${historical.length} samples) — predictions uncertain`);
    }

    return risks;
  }

  private generateRecommendations(input: {
    goalType: string;
    runtime: string;
  }, historical: Array<{ status: string; durationMs: number }>, risks: string[], successRate: number): string[] {
    const recommendations: string[] = [];

    // Use goal type for recommendations
    if (input.goalType) {
      recommendations.push(`Goal type "${input.goalType}" — using specialized strategy`);
    }

    if (risks.some((r) => r.includes('Low historical success rate'))) {
      recommendations.push('Consider using a different runtime based on historical success rates');
    }

    if (risks.some((r) => r.includes('Insufficient historical data'))) {
      recommendations.push('Run a small test loop before committing to full execution');
    }

    recommendations.push(historical.length > 0
      ? `Expected success rate: ${(successRate * 100).toFixed(0)}%`
      : 'Expected success rate: 50% neutral prior; no matching history');

    return recommendations;
  }

  /**
   * Check data quality of the system.
   */
  checkDataQuality(): {
    failureMetadataCompleteness: number;
    blockReasonCompleteness: number;
    staleLeaseCount: number;
    overallScore: number;
    recommendations: string[];
  } {
    const recommendations: string[] = [];

    // Check failure metadata completeness
    const failedLeases = this.db.prepare("SELECT COUNT(*) as c FROM worker_leases WHERE status = 'failed'").get() as any;
    const failedWithMetadata = this.db.prepare(`
      SELECT COUNT(*) as c FROM worker_leases
      WHERE status = 'failed'
      AND json_extract(metadata, '$.exit_status') IS NOT NULL
      AND json_extract(metadata, '$.exit_status') != ''
    `).get() as any;
    const failureMetadataCompleteness = failedLeases.c > 0 ? failedWithMetadata.c / failedLeases.c : 1;

    if (failureMetadataCompleteness < 0.9) {
      recommendations.push(`Failure metadata completeness: ${(failureMetadataCompleteness * 100).toFixed(0)}% — executeMaker should record metadata before throwing`);
    }

    // Check block reason completeness
    const blockedLoops = this.db.prepare("SELECT COUNT(*) as c FROM loop_runs WHERE status = 'blocked'").get() as any;
    const blockedWithReason = this.db.prepare(`
      SELECT COUNT(*) as c FROM loop_runs
      WHERE status = 'blocked'
      AND json_extract(metadata, '$.block_reason') IS NOT NULL
      AND json_extract(metadata, '$.block_reason') != ''
    `).get() as any;
    const blockReasonCompleteness = blockedLoops.c > 0 ? blockedWithReason.c / blockedLoops.c : 1;

    if (blockReasonCompleteness < 0.9) {
      recommendations.push(`Block reason completeness: ${(blockReasonCompleteness * 100).toFixed(0)}% — verifyLoopRun should record block reasons`);
    }

    // Count stale leases
    const stalePrepared = this.db.prepare(`
      SELECT COUNT(*) as c FROM worker_leases
      WHERE status = 'prepared' AND created_at < datetime('now', '-24 hours')
    `).get() as any;
    const staleRunning = this.db.prepare(`
      SELECT COUNT(*) as c FROM worker_leases
      WHERE status = 'running' AND updated_at < datetime('now', '-2 hours')
    `).get() as any;
    const staleLeaseCount = (stalePrepared.c || 0) + (staleRunning.c || 0);

    if (staleLeaseCount > 0) {
      recommendations.push(`${staleLeaseCount} stale leases detected — run stale-resource-cleanup worker`);
    }

    const overallScore = (failureMetadataCompleteness * 0.4 + blockReasonCompleteness * 0.4 + (staleLeaseCount === 0 ? 1 : 0) * 0.2);

    return {
      failureMetadataCompleteness,
      blockReasonCompleteness,
      staleLeaseCount,
      overallScore,
      recommendations,
    };
  }
}
