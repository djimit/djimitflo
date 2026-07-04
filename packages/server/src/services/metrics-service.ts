/**
 * MetricsService — Prometheus-compatible metrics for production monitoring.
 *
 * Tracks: loop execution times, success rates, token usage, governance scores,
 * active leases, queue depth, and system health.
 */

import type { Database } from 'better-sqlite3';

interface MetricSnapshot {
  timestamp: string;
  loops: {
    total: number;
    running: number;
    completed: number;
    failed: number;
    avgDurationMs: number;
    successRate: number;
  };
  workers: {
    total: number;
    running: number;
    prepared: number;
    failed: number;
  };
  governance: {
    monitoredAgents: number;
    quarantinedAgents: number;
    circuitBreakerTripped: number;
  };
  tokens: {
    totalUsed: number;
    totalCostDollars: number;
  };
  system: {
    uptimeSeconds: number;
    memoryUsageMb: number;
    diskUsagePercent: number;
  };
}

export class MetricsService {
  private startTime = Date.now();

  constructor(private db: Database) {}

  /**
   * Get a full metrics snapshot.
   */
  getSnapshot(): MetricSnapshot {
    const loops = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM loop_runs
    `).get() as any;

    const workers = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
        SUM(CASE WHEN status = 'prepared' THEN 1 ELSE 0 END) as prepared,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM worker_leases
    `).get() as any;

    const tokens = this.db.prepare(`
      SELECT
        COALESCE(SUM(
          CASE WHEN metadata LIKE '%total_tokens%'
          THEN CAST(json_extract(metadata, '$.total_tokens') AS INTEGER)
          ELSE 0 END
        ), 0) as total_used
      FROM worker_leases
    `).get() as any;

    return {
      timestamp: new Date().toISOString(),
      loops: {
        total: loops.total || 0,
        running: loops.running || 0,
        completed: loops.completed || 0,
        failed: loops.failed || 0,
        avgDurationMs: 0, // Would need timing data
        successRate: loops.total > 0 ? (loops.completed / loops.total) : 1,
      },
      workers: {
        total: workers.total || 0,
        running: workers.running || 0,
        prepared: workers.prepared || 0,
        failed: workers.failed || 0,
      },
      governance: {
        monitoredAgents: 0, // From RuntimeGovernanceService state
        quarantinedAgents: 0,
        circuitBreakerTripped: 0,
      },
      tokens: {
        totalUsed: tokens.total_used || 0,
        totalCostDollars: 0,
      },
      system: {
        uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
        memoryUsageMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        diskUsagePercent: 0, // Would need fs.stat
      },
    };
  }

  /**
   * Get Prometheus-format metrics.
   */
  getPrometheusMetrics(): string {
    const snapshot = this.getSnapshot();
    const lines: string[] = [];

    // Loop metrics
    lines.push('# HELP djimitflo_loops_total Total loop runs');
    lines.push('# TYPE djimitflo_loops_total gauge');
    lines.push(`djimitflo_loops_total{status="all"} ${snapshot.loops.total}`);
    lines.push(`djimitflo_loops_total{status="running"} ${snapshot.loops.running}`);
    lines.push(`djimitflo_loops_total{status="completed"} ${snapshot.loops.completed}`);
    lines.push(`djimitflo_loops_total{status="failed"} ${snapshot.loops.failed}`);

    // Success rate
    lines.push('# HELP djimitflo_loops_success_rate Loop success rate');
    lines.push('# TYPE djimitflo_loops_success_rate gauge');
    lines.push(`djimitflo_loops_success_rate ${snapshot.loops.successRate}`);

    // Worker metrics
    lines.push('# HELP djimitflo_workers_total Total worker leases');
    lines.push('# TYPE djimitflo_workers_total gauge');
    lines.push(`djimitflo_workers_total{status="all"} ${snapshot.workers.total}`);
    lines.push(`djimitflo_workers_total{status="running"} ${snapshot.workers.running}`);
    lines.push(`djimitflo_workers_total{status="prepared"} ${snapshot.workers.prepared}`);

    // System metrics
    lines.push('# HELP djimitflo_system_uptime_seconds System uptime');
    lines.push('# TYPE djimitflo_system_uptime_seconds counter');
    lines.push(`djimitflo_system_uptime_seconds ${snapshot.system.uptimeSeconds}`);

    lines.push('# HELP djimitflo_system_memory_usage_mb Memory usage');
    lines.push('# TYPE djimitflo_system_memory_usage_mb gauge');
    lines.push(`djimitflo_system_memory_usage_mb ${snapshot.system.memoryUsageMb}`);

    return lines.join('\n');
  }
}
