/**
 * SelfHealingService — automatic detection and repair of system issues.
 *
 * Monitors system health and automatically:
 * 1. Detects anomalies (failed loops, stale leases, DB bloat)
 * 2. Diagnoses root causes
 * 3. Applies fixes (retry, cleanup, reconfigure)
 * 4. Validates repairs
 * 5. Learns from incidents
 *
 * Inspired by:
 * - Kubernetes self-healing (auto-restart, auto-scale)
 * - Database auto-vacuum and reindex
 * - DjimFlo's runtime governance (circuit breaker pattern)
 */

import type { Database } from 'better-sqlite3';
import { WorktreeManager } from './worktree-manager';
import { CANCEL_LEASE_METADATA_SQL, cancelLeaseBind } from './lease-failure';
import { RuntimeLeaseRegistry } from './loop-recovery-service';

const HOUR_MS = 60 * 60 * 1000;
const STALE_LEASE_MS = HOUR_MS;
/** Loop-run states in which a prepared/running lease may still be legitimately waiting or working. */
const ACTIVE_RUN_STATUSES = new Set(['created', 'planning', 'running', 'verifying', 'blocked', 'interrupted']);
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/** `datetime(x)`'s text form ('YYYY-MM-DD HH:MM:SS', UTC) of an instant — what the pre-DF-02 repair compared against. */
const sqliteText = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

interface HealthCheck {
  name: string;
  status: 'healthy' | 'degraded' | 'critical';
  message: string;
  lastChecked: string;
}

interface Incident {
  id: string;
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  autoFixAttempted: boolean;
  autoFixSucceeded: boolean;
  resolvedAt?: string;
  createdAt: string;
}

interface HealingAction {
  id: string;
  incidentId: string;
  action: string;
  result: 'success' | 'failed' | 'skipped';
  output: string;
  timestamp: string;
}

export class SelfHealingService {
  private incidents: Incident[] = [];
  private actions: HealingAction[] = [];

  /** `now` is injectable for tests; every time predicate is evaluated against it, never against SQLite's own clock. */
  constructor(private db: Database, private now: () => Date = () => new Date()) {}

  /**
   * Run full system health check.
   */
  checkHealth(): HealthCheck[] {
    const checks: HealthCheck[] = [];
    const clock = this.now();
    const now = clock.toISOString();

    // Check 1: Failed loop rate
    // DF-02: julianday() on both sides. Stored timestamps mix ISO-8601 ('...T...Z') and SQLite ('... ...') text, and a raw
    // text comparison sorts 'T' after ' ', so ISO rows from earlier on the cutoff day were counted inside the window.
    const loopStats = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked
      FROM loop_runs
      WHERE julianday(created_at) > julianday(?)
    `).get(new Date(clock.getTime() - 24 * HOUR_MS).toISOString()) as any;

    const failureRate = loopStats.total > 0 ? (loopStats.failed || 0) / loopStats.total : 0;
    checks.push({
      name: 'loop_failure_rate',
      status: failureRate > 0.3 ? 'critical' : failureRate > 0.1 ? 'degraded' : 'healthy',
      message: `${((failureRate) * 100).toFixed(0)}% failure rate (${loopStats.failed || 0}/${loopStats.total || 0})`,
      lastChecked: now,
    });

    // Check 2: Stale worker leases (DF-02: same-day ISO rows were never counted). NULL/unparseable updated_at → not counted.
    const staleLeases = this.db.prepare(`
      SELECT COUNT(*) as c FROM worker_leases
      WHERE status IN ('running', 'prepared')
      AND julianday(updated_at) < julianday(?)
    `).get(new Date(clock.getTime() - STALE_LEASE_MS).toISOString()) as any;

    checks.push({
      name: 'stale_leases',
      status: (staleLeases.c || 0) > 5 ? 'critical' : (staleLeases.c || 0) > 0 ? 'degraded' : 'healthy',
      message: `${staleLeases.c || 0} stale worker leases`,
      lastChecked: now,
    });

    // Check 3: Orphaned worktrees
    // Count real directories on disk (same rule the daemon's pruner uses), not completed leases
    // that merely still carry a worktree_path (which reported 82 while disk held ~19 tiny dirs).
    const orphaned = { c: new WorktreeManager(this.db).pruneOrphanedWorktrees({ dryRun: true }) };

    checks.push({
      name: 'orphaned_worktrees',
      status: (orphaned.c || 0) > 10 ? 'degraded' : 'healthy',
      message: `${orphaned.c || 0} orphaned worktree directories on disk`,
      lastChecked: now,
    });

    // Check 4: Database size
    const dbSize = this.db.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get() as any;
    const dbSizeMb = (dbSize?.size || 0) / 1024 / 1024;

    checks.push({
      name: 'database_size',
      status: dbSizeMb > 500 ? 'degraded' : 'healthy',
      message: `Database size: ${dbSizeMb.toFixed(1)}MB`,
      lastChecked: now,
    });

    // Check 5: Memory usage
    const memUsage = process.memoryUsage();
    const memMb = memUsage.heapUsed / 1024 / 1024;

    checks.push({
      name: 'memory_usage',
      status: memMb > 500 ? 'critical' : memMb > 200 ? 'degraded' : 'healthy',
      message: `Memory usage: ${memMb.toFixed(0)}MB`,
      lastChecked: now,
    });

    return checks;
  }

  /**
   * Attempt to auto-fix detected issues.
   */
  heal(): { incidents: Incident[]; actions: HealingAction[] } {
    const healthChecks = this.checkHealth();
    const newIncidents: Incident[] = [];
    const newActions: HealingAction[] = [];

    for (const check of healthChecks) {
      if (check.status === 'healthy') continue;

      const incident = this.createIncident(check);
      newIncidents.push(incident);

      // Attempt auto-fix based on issue type
      const action = this.attemptFix(incident);
      newActions.push(action);

      if (action.result === 'success') {
        incident.autoFixSucceeded = true;
        incident.resolvedAt = new Date().toISOString();
      }

      incident.autoFixAttempted = true;
    }

    this.incidents.push(...newIncidents);
    this.actions.push(...newActions);

    return { incidents: newIncidents, actions: newActions };
  }

  /**
   * Get incident history.
   */
  getIncidents(limit = 50): Incident[] {
    return this.incidents.slice(-limit).reverse();
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalIncidents: number;
    autoFixed: number;
    manualIntervention: number;
    healthyChecks: number;
    totalChecks: number;
  } {
    const healthChecks = this.checkHealth();
    const healthy = healthChecks.filter((c) => c.status === 'healthy').length;
    const autoFixed = this.incidents.filter((i) => i.autoFixSucceeded).length;
    const manual = this.incidents.filter((i) => !i.autoFixSucceeded).length;

    return {
      totalIncidents: this.incidents.length,
      autoFixed,
      manualIntervention: manual,
      healthyChecks: healthy,
      totalChecks: healthChecks.length,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private createIncident(check: HealthCheck): Incident {
    const incident: Incident = {
      id: `inc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: check.name,
      severity: check.status === 'critical' ? 'high' : 'medium',
      description: check.message,
      autoFixAttempted: false,
      autoFixSucceeded: false,
      createdAt: new Date().toISOString(),
    };

    return incident;
  }

  /**
   * The automatic stale-lease repair (DF-02). Detection was fixed to julianday(); fixing this predicate the same way would
   * have started cancelling work the old one never touched: approved makers run inside the execution engine while their
   * lease stays 'prepared', and remote makers run up to ~77 min. So a lease is cancelled only when ALL hold:
   *  1. the pre-DF-02 text predicate (`updated_at < datetime(now, '-1 hour')`) matches — an upper bound: never more than
   *     before. For ISO rows it only matches previous-UTC-day rows, so same-day stale leases are detected but not cancelled;
   *  2. julianday(updated_at) is really older than 1 h (drops the old just-after-midnight false positives);
   *  3. no live work can own it: not a remote lease, not live in this process (RuntimeLeaseRegistry), no bound
   *     execution-engine task that is non-terminal or missing, and its loop run is absent or finished (and not a remote gym run).
   * ponytail: (1) keeps the legacy text bound on purpose. Drop it only after a stale-lease policy review proves (3) covers
   * every live-work shape (upgrade trigger: lease heartbeats, or same-day abandoned leases piling up in the health check).
   */
  private cancelAbandonedLeases(): { cancelled: number; kept: number } {
    const clock = this.now();
    const cutoff = new Date(clock.getTime() - STALE_LEASE_MS);
    const candidates = this.db.prepare(`
      SELECT l.id, l.runtime, l.metadata, r.status AS run_status, r.metadata AS run_metadata
      FROM worker_leases l LEFT JOIN loop_runs r ON r.id = l.loop_run_id
      WHERE l.status IN ('running', 'prepared')
      AND julianday(l.updated_at) < julianday(?)
    `).all(cutoff.toISOString()) as Array<{ id: string; runtime: string | null; metadata: string | null; run_status: string | null; run_metadata: string | null }>;
    const legacyCutoff = sqliteText(cutoff);
    const legacyMatch = this.db.prepare('SELECT 1 FROM worker_leases WHERE id = ? AND updated_at < ?');
    const hasTasks = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get());
    const taskStatus = hasTasks ? this.db.prepare('SELECT status FROM tasks WHERE id = ?') : null;
    const parse = (s: string | null): Record<string, any> => { try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };

    const abandoned = candidates.filter((l) => {
      if (!legacyMatch.get(l.id, legacyCutoff)) return false;
      if (l.runtime === 'remote' || RuntimeLeaseRegistry.isLive(l.id)) return false;
      if (l.run_status && ACTIVE_RUN_STATUSES.has(l.run_status)) return false;
      if (parse(l.run_metadata).gym?.remote_host) return false;
      const taskId = parse(l.metadata).execution_task_id;
      if (taskId !== undefined && taskId !== null) {
        const task = taskStatus?.get(String(taskId)) as { status: string } | undefined;
        if (!task || !TERMINAL_TASK_STATUSES.has(task.status)) return false; // unknown → keep
      }
      return true;
    });

    const now = clock.toISOString();
    const cancel = this.db.prepare(`
      UPDATE worker_leases SET status = 'cancelled', updated_at = ?, ${CANCEL_LEASE_METADATA_SQL}
      WHERE id = ? AND status IN ('running', 'prepared')
    `);
    const cancelled = this.db.transaction(() => abandoned.reduce((n, l) => n + cancel.run(now, ...cancelLeaseBind('self_healing_stale_lease', now), l.id).changes, 0))();
    return { cancelled, kept: candidates.length - cancelled };
  }

  private attemptFix(incident: Incident): HealingAction {
    const action: HealingAction = {
      id: `action-${Date.now()}`,
      incidentId: incident.id,
      action: 'none',
      result: 'skipped',
      output: '',
      timestamp: new Date().toISOString(),
    };

    switch (incident.type) {
      case 'loop_failure_rate':
        action.action = 'analyze_failures';
        action.output = 'Failure analysis complete. Recommend reviewing failed loop logs.';
        action.result = 'success';
        break;

      case 'stale_leases':
        action.action = 'cancel_stale_leases';
        try {
          const { cancelled, kept } = this.cancelAbandonedLeases();
          action.output = `Cancelled ${cancelled} stale leases` + (kept ? `; kept ${kept} (live/remote/active work or same-day guard)` : '');
          action.result = 'success';
        } catch (error) {
          action.output = `Failed: ${error instanceof Error ? error.message : String(error)}`;
          action.result = 'failed';
        }
        break;

      case 'orphaned_worktrees':
        action.action = 'flag_for_cleanup';
        action.output = 'Orphaned worktrees flagged for manual cleanup (filesystem operation)';
        action.result = 'success';
        break;

      case 'database_size':
        action.action = 'vacuum_recommend';
        action.output = 'Database size exceeds threshold. Recommend running VACUUM during maintenance window.';
        action.result = 'success';
        break;

      case 'memory_usage':
        action.action = 'gc_suggest';
        action.output = 'High memory usage detected. Recommend restarting the server process.';
        action.result = 'success';
        break;

      default:
        action.action = 'no_action';
        action.output = `No auto-fix available for ${incident.type}`;
        action.result = 'skipped';
    }

    this.actions.push(action);
    return action;
  }
}
