/**
 * LoopRecoveryService — handles recovery of interrupted loop runs after server restart.
 *
 * When the server restarts, in-memory process handles are lost. This service:
 * 1. Marks orphaned worker leases as 'failed'
 * 2. Marks orphaned loop runs as 'interrupted'
 * 3. Provides resume logic for interrupted runs
 *
 * Extracted from LoopService to isolate recovery logic.
 */

import type { Database } from 'better-sqlite3';
import { swarmEventBus } from './swarm-event-bus';
import { WorkerLeaseRepo } from './loop-worker-lease-repo';
import { LoopRunQueryService } from './loop-run-query-service';
import { LoopRunMutationService } from './loop-run-mutation-service';
import { ExperienceRetrievalService } from './experience-retrieval-service';
import { createError } from '../middleware/error-handler';
import type { WorkerLeaseRecord } from './loop-types';
import { LoopEventService } from './loop-event-service';
import { SelfImprovementService } from './self-improvement-service';
import { CANCEL_LEASE_METADATA_SQL, cancelLeaseBind } from './lease-failure';

export interface RecoveryResult {
  interruptedRuns: number;
  failedLeases: number;
  /** zombie runs settled at boot (prepared leases cancelled, goal failed, proposal infra_failed) — see settleDeployRestartRun */
  settledRuns: number;
}

export interface ResumeResult {
  resumed: boolean;
  boundedFail: boolean;
  resumeAttempt: number;
  requeuedFindings: string[];
  skippedFindings: string[];
}

/**
 * Shared state for runtime leases across the loop subsystem.
 * Previously a static field on LoopService.
 */
export class RuntimeLeaseRegistry {
  private static leases = new Map<string, { leaseId: string; startedAt: string; stop?: () => Promise<void> }>();

  static register(leaseId: string, stop?: () => Promise<void>): () => void {
    const lease = { leaseId, startedAt: new Date().toISOString(), stop };
    this.leases.set(leaseId, lease);
    return () => { if (this.leases.get(leaseId) === lease) this.leases.delete(leaseId); };
  }

  static async stop(leaseId: string): Promise<boolean> {
    const stop = this.leases.get(leaseId)?.stop;
    if (!stop) return false;
    await stop();
    return true;
  }

  static unregister(leaseId: string): void {
    this.leases.delete(leaseId);
  }

  static isLive(leaseId: string): boolean {
    return this.leases.has(leaseId);
  }

  static getLiveIds(): Set<string> {
    return new Set(this.leases.keys());
  }

  static count(): number {
    return this.leases.size;
  }

  static clear(): void {
    this.leases.clear();
  }
}

export class LoopRecoveryService {
  private leases: WorkerLeaseRepo;
  private queries: LoopRunQueryService;
  private mutations: LoopRunMutationService;
  private experience: ExperienceRetrievalService;
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.leases = new WorkerLeaseRepo(db);
    this.queries = new LoopRunQueryService(db);
    this.mutations = new LoopRunMutationService(db);
    this.experience = new ExperienceRetrievalService(db);
  }

  private isAwaitingApproval(runId: string): boolean {
    try {
      return Boolean(this.db.prepare("SELECT 1 FROM goals WHERE status = 'blocked' AND json_extract(COALESCE(NULLIF(metadata, ''), '{}'), '$.awaiting_approval.run_id') = ? LIMIT 1").get(runId));
    } catch { return false; } // minimal schemas without a goals table
  }

  /**
   * Incident 17-10: a goal 'blocked' on an approval that was already approved, whose engine task never reached a terminal
   * state, waits for nothing — the restart killed the task (resumeApprovalBlockedGoals only continues once the task ended).
   * Pending, missing, denied/expired (the daemon fails those) or approved-and-finished (the daemon resumes) are real waits.
   */
  private approvalWaitIsDead(runId: string): boolean {
    try {
      const row = this.db.prepare(`SELECT a.status AS approval, t.status AS task FROM goals g
        JOIN approvals a ON a.id = json_extract(g.metadata, '$.awaiting_approval.approval_id')
        LEFT JOIN tasks t ON t.id = a.task_id
        WHERE g.status = 'blocked' AND json_extract(COALESCE(NULLIF(g.metadata, ''), '{}'), '$.awaiting_approval.run_id') = ? LIMIT 1`).get(runId) as { approval: string; task: string | null } | undefined;
      return row?.approval === 'approved' && !['completed', 'failed', 'cancelled'].includes(row.task ?? '');
    } catch { return false; }
  }

  /**
   * Incident 17-10 (prod): a deploy restart killed three local makers; their runs stayed 'running' with every lease 'prepared',
   * goals 'blocked', proposals 'executing' for 15 h and filled the test-gap in-flight cap. A LOCAL run that is 'running', had
   * no lease 'running' and no live lease, no pending approval on any of its tasks, no remote lease, and whose last activity
   * predates this boot is settled: run interrupted, prepared leases cancelled (cancellation_reason 'deploy_restart'), its
   * running/blocked goal failed and its in-flight proposal infra_failed (requeueable; no verdict on the proposal).
   */
  private settleDeployRestartRun(run: { id: string; goal_id: string | null; metadata: Record<string, unknown> }, bootedAt: string, now: string): boolean {
    const one = (sql: string, ...args: unknown[]) => this.db.prepare(sql).get(...args);
    if ((run.metadata as { gym?: { remote_host?: unknown } }).gym?.remote_host) return false;
    if (one("SELECT 1 FROM worker_leases WHERE loop_run_id = ? AND runtime = 'remote' AND status IN ('prepared', 'running') LIMIT 1", run.id)) return false;
    if (one(`SELECT 1 FROM worker_leases l JOIN approvals a ON a.task_id = json_extract(l.metadata, '$.execution_task_id')
      WHERE l.loop_run_id = ? AND a.status = 'pending' LIMIT 1`, run.id)) return false;
    const last = one(`SELECT MAX(t) AS t FROM (
        SELECT julianday(updated_at) AS t FROM loop_runs WHERE id = ?
        UNION ALL SELECT julianday(updated_at) FROM worker_leases WHERE loop_run_id = ?
        UNION ALL SELECT julianday(created_at) FROM loop_events WHERE loop_run_id = ?)`, run.id, run.id, run.id) as { t: number | null } | undefined;
    const boot = (one('SELECT julianday(?) AS b', bootedAt) as { b: number | null }).b;
    if (last?.t == null || boot == null || last.t >= boot) return false;
    const goal = run.goal_id ? one("SELECT id, improvement_id FROM goals WHERE id = ? AND status IN ('running', 'blocked')", run.goal_id) as { id: string; improvement_id: string | null } | undefined : undefined;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE worker_leases SET status = 'cancelled', updated_at = ?, ${CANCEL_LEASE_METADATA_SQL}
        WHERE loop_run_id = ? AND status = 'prepared'`).run(now, ...cancelLeaseBind('deploy_restart', now), run.id);
      this.mutations.updateStatus(run.id, 'interrupted', { interrupted_reason: 'server_restart', interrupted_at: now, settled: 'deploy_restart', settled_goal_id: goal?.id ?? null });
      if (goal) {
        this.db.prepare(`UPDATE goals SET status = 'failed', updated_at = ?,
          metadata = json_set(json_remove(COALESCE(NULLIF(metadata, ''), '{}'), '$.awaiting_approval'), '$.settled', 'deploy_restart', '$.settled_at', ?) WHERE id = ?`).run(now, now, goal.id);
        if (goal.improvement_id) new SelfImprovementService(this.db).recordOutcome(goal.improvement_id, 'infra_failed');
      }
    })();
    try {
      new LoopEventService(this.db).recordEvent(run.id, 'goal_failed', 'error', 'deploy_restart: the restart killed this run\'s worker; settled at boot', { goal_id: goal?.id ?? null, settled: 'deploy_restart' });
    } catch { /* best-effort */ }
    return true;
  }

  /**
   * Recover in-flight work orphaned by a server crash/restart.
   * Safe to call at any time. Idempotent.
   */
  recoverInterruptedRuns(opts: { bootedAt?: string } = {}): RecoveryResult {
    const now = new Date().toISOString();
    const bootedAt = opts.bootedAt ?? new Date(Date.now() - process.uptime() * 1000).toISOString();
    const liveLeaseIds = RuntimeLeaseRegistry.getLiveIds();

    // Fail 'running' leases whose child process is gone.
    const runningLeases = this.leases.getRunning();
    const runsWithRunningLease = new Set(runningLeases.map((l) => l.loop_run_id));
    let failedLeases = 0;
    for (const lease of runningLeases) {
      if (liveLeaseIds.has(lease.id)) continue;
      this.leases.updateStatus(lease.id, 'failed', {
        failed_reason: 'server_restart',
        failed_at: now,
      });
      failedLeases++;
    }

    // Runs in an active status whose worker leases are all non-live are orphaned.
    const liveRunIds = this.leases.getLoopRunIdsForLeases(Array.from(liveLeaseIds));
    const activeRuns = this.queries.getActive();
    let interruptedRuns = 0;
    let settledRuns = 0;
    for (const run of activeRuns) {
      if (run.status === 'planning') continue;
      if (liveRunIds.has(run.id)) continue;
      const zombie = run.status === 'running' && !runsWithRunningLease.has(run.id);
      // A run whose goal deliberately waits for a human approval is idle, not orphaned: a restart must not flip it to
      // 'interrupted' (it lost its place in the approval flow and later got cancelled by the zombie reaper).
      // Unless the approval was already given and the restart killed the approved task (incident 17-10).
      if (this.isAwaitingApproval(run.id)) {
        if (zombie && this.approvalWaitIsDead(run.id) && this.settleDeployRestartRun(run, bootedAt, now)) { void this.experience.indexRun(run.id); interruptedRuns++; settledRuns++; }
        continue;
      }
      // A remote gym run executes on its host, not here: a VPS restart does not touch it (prod 2026-09-27 23:46: a deploy 9 s
      // after the claim marked it interrupted and the host's report 15 min later was refused). If the host really lost
      // it, its next claim settles it (RemoteGymService).
      if ((run.metadata as { gym?: { remote_host?: unknown } } | undefined)?.gym?.remote_host) continue;
      if (zombie && this.settleDeployRestartRun(run, bootedAt, now)) { void this.experience.indexRun(run.id); interruptedRuns++; settledRuns++; continue; }
      this.mutations.updateStatus(run.id, 'interrupted', {
        interrupted_reason: 'server_restart',
        interrupted_at: now,
      });
      void this.experience.indexRun(run.id);
      interruptedRuns++;
    }

    return { interruptedRuns, failedLeases, settledRuns };
  }

  /**
   * Resume an interrupted run. Bounded by maxResumeAttempts.
   */
  resumeInterruptedRun(runId: string, maxResumeAttempts = 3): ResumeResult {
    const run = this.queries.getById(runId);
    if (run.metadata.operator_paused === true) throw createError(409, 'LOOP_OPERATOR_PAUSED', 'LOOP_OPERATOR_PAUSED');
    if (run.status !== 'interrupted') {
      throw new Error('LOOP_RUN_NOT_INTERRUPTED');
    }

    const metadata = run.metadata;
    const resumeAttempts = (metadata.resume_attempts as number ?? 0) + 1;

    if (resumeAttempts > maxResumeAttempts) {
      this.mutations.updateStatus(runId, 'failed', { resume_attempts: resumeAttempts });
      void this.experience.indexRun(runId);
      return { resumed: false, boundedFail: true, resumeAttempt: resumeAttempts, requeuedFindings: [], skippedFindings: [] };
    }

    const findings = run.findings;
    const completedFindings = new Set<string>();
    const leaseStatuses = this.leases.getFindingStatuses(runId);
    for (const ls of leaseStatuses) {
      if (ls.status === 'completed' && ls.finding_id) completedFindings.add(ls.finding_id);
    }

    const requeuedFindings: string[] = [];
    const skippedFindings: string[] = [];

    for (const finding of findings) {
      if (completedFindings.has(finding.id)) {
        skippedFindings.push(finding.id);
      } else {
        requeuedFindings.push(finding.id);
      }
    }

    this.mutations.updateStatus(runId, 'running', { resume_attempts: resumeAttempts });

    swarmEventBus.emit('recovery', {
      run_id: runId,
      resumed: true,
      requeued_findings: requeuedFindings.length,
    });

    return { resumed: true, boundedFail: false, resumeAttempt: resumeAttempts, requeuedFindings, skippedFindings };
  }

  /**
   * Resume all interrupted runs.
   */
  resumeInterruptedRuns(): { resumed: number; boundedFailed: number; details: Array<{ runId: string; resumed: boolean }> } {
    const interruptedRuns = this.queries.getInterrupted();
    const details: Array<{ runId: string; resumed: boolean }> = [];
    let resumed = 0;
    let boundedFailed = 0;

    for (const run of interruptedRuns) {
      if (run.metadata.operator_paused === true) continue;
      const result = this.resumeInterruptedRun(run.id);
      details.push({ runId: run.id, resumed: result.resumed });
      if (result.resumed) resumed++;
      else boundedFailed++;
    }

    return { resumed, boundedFailed, details };
  }

  /**
   * Check if a worker lease is cancelled or stopped.
   */
  isWorkerLeaseCancelled(leaseId: string): boolean {
    return this.leases.isCancelled(leaseId);
  }

  /**
   * Get a worker lease by ID.
   */
  getWorkerLease(leaseId: string): WorkerLeaseRecord {
    return this.leases.getById(leaseId);
  }
}
