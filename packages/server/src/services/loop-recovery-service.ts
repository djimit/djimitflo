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
import { WorkerLeaseRepo } from './loop-worker-lease-repo';
import { LoopRunQueryService } from './loop-run-query-service';
import { LoopRunMutationService } from './loop-run-mutation-service';
import { ExperienceRetrievalService } from './experience-retrieval-service';
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

export type ResumeInterruptedMode = 'off' | 'shadow' | 'on';
export const MAX_RESUME_ATTEMPTS = 3;
/** LOOP_RESUME_INTERRUPTED: off (default) | shadow (record only) | on (resume at boot). Anything else is off. */
export function resumeInterruptedMode(env: NodeJS.ProcessEnv = process.env): ResumeInterruptedMode {
  const v = env.LOOP_RESUME_INTERRUPTED;
  return v === 'on' || v === 'shadow' ? v : 'off';
}

export interface ResumeInterruptedSummary {
  mode: ResumeInterruptedMode;
  resumed: number;
  skipped: number;
  details: Array<{ runId: string; resumed: boolean; reason: string }>;
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

  private queuedForResume(runId: string, goalId: string | null): boolean {
    if (!goalId) return false;
    try {
      return Boolean(this.db.prepare("SELECT 1 FROM goals WHERE id = ? AND status = 'decomposed' AND json_extract(COALESCE(NULLIF(metadata, ''), '{}'), '$.resume_run_id') = ?").get(goalId, runId));
    } catch { return false; }
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
      // RIR: a run resumeInterruptedRuns already re-queued (fresh prepared maker, goal 'decomposed' + resume_run_id) has
      // nothing in flight; a second restart before the daemon picked it up must not settle it or retry it again.
      if (run.metadata.resumed_at && this.queuedForResume(run.id, run.goal_id)) continue;
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
   * RIR (LOOP_RESUME_INTERRUPTED, default off): a run this boot marked interrupted (server_restart, not settled by the
   * deploy-restart rule above) gets ONE fresh prepared maker via `retry` (retryLoopRun: its retry budget and pause/escalation
   * asserts apply) and its goal goes back to 'decomposed' with metadata.resume_run_id, so the daemon's next tick picks it
   * up through the same path as an approval resume (authority gate, maker approval, checks, reviewers all run again).
   * Never resumed: an execution task whose external outcome is unknown (execution_recovery_hold or still non-terminal —
   * the engine reconciles tasks after loop recovery at boot), resume_attempts >= 3 (left for queue hygiene), a goal that
   * is not 'running' or a proposal that is not 'executing' (cancelled/blocked/paused by an operator), a run with a
   * completed maker (the daemon would treat it as done), and remote gym runs (never interrupted at boot).
   * `shadow` records `run_resume_shadow` per candidate and changes nothing.
   */
  resumeInterruptedRuns(retry: (runId: string) => { retry_maker: { id: string } }, opts: { bootedAt?: string; mode?: ResumeInterruptedMode } = {}): ResumeInterruptedSummary {
    const mode = opts.mode ?? resumeInterruptedMode();
    const summary: ResumeInterruptedSummary = { mode, resumed: 0, skipped: 0, details: [] };
    if (mode === 'off') return summary;
    const bootedAt = opts.bootedAt ?? new Date(Date.now() - process.uptime() * 1000).toISOString();
    const events = new LoopEventService(this.db);
    for (const run of this.queries.getInterrupted()) {
      const meta = run.metadata as Record<string, unknown>;
      // only runs this boot interrupted: an older interrupted run (or one interrupted while the flag was off) is left alone
      if (meta.interrupted_reason !== 'server_restart' || meta.settled || typeof meta.interrupted_at !== 'string' || meta.interrupted_at < bootedAt) continue;
      const attempt = (Number(meta.resume_attempts) || 0) + 1;
      let reason = this.resumeBlocker(run);
      if (mode === 'shadow') {
        try { events.recordEvent(run.id, 'run_resume_shadow', 'info', reason ? `would not resume: ${reason}` : 'would resume', { would_resume: !reason, reason: reason ?? 'server_restart', resume_attempt: attempt }); } catch { /* telemetry */ }
        summary.details.push({ runId: run.id, resumed: false, reason: reason ?? 'shadow' });
        continue;
      }
      let retryMakerLeaseId: string | null = null;
      if (!reason) {
        try { retryMakerLeaseId = retry(run.id).retry_maker.id; } catch (error) { reason = error instanceof Error ? error.message : String(error); }
      }
      if (!retryMakerLeaseId) {
        summary.skipped++;
        summary.details.push({ runId: run.id, resumed: false, reason: reason! });
        try { events.recordEvent(run.id, 'run_resume_skipped', 'warning', `Not resumed after restart: ${reason}`, { reason, resume_attempt: attempt }); } catch { /* best-effort */ }
        continue;
      }
      const now = new Date().toISOString();
      this.db.transaction(() => {
        this.mutations.updateStatus(run.id, 'running', { resume_attempts: attempt, resumed_at: now, resume_reason: 'server_restart' });
        this.db.prepare(`UPDATE goals SET status = 'decomposed', metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.resume_run_id', ?), updated_at = ?
          WHERE id = ? AND status = 'running'`).run(run.id, now, run.goal_id);
        events.recordEvent(run.id, 'run_resumed', 'info', `Resumed after server restart (attempt ${attempt}): fresh maker ${retryMakerLeaseId}`,
          { reason: 'server_restart', resume_attempt: attempt, retry_maker_lease_id: retryMakerLeaseId, goal_id: run.goal_id });
      })();
      summary.resumed++;
      summary.details.push({ runId: run.id, resumed: true, reason: 'server_restart' });
    }
    return summary;
  }

  /** Why an interrupted run must not be resumed, or null. Unknown (a failed read) is a blocker, never a pass. */
  private resumeBlocker(run: { id: string; goal_id: string | null; metadata: Record<string, unknown> }): string | null {
    const meta = run.metadata;
    if (meta.operator_paused === true) return 'operator_paused';
    if ((meta as { gym?: { remote_host?: unknown } }).gym?.remote_host) return 'remote_run';
    if (meta.execution_recovery_hold === true) return 'execution_recovery_hold';
    if ((Number(meta.resume_attempts) || 0) >= MAX_RESUME_ATTEMPTS) return 'resume_attempts_exhausted';
    if (!run.goal_id) return 'no_goal';
    try {
      const goal = this.db.prepare('SELECT status, improvement_id, metadata FROM goals WHERE id = ?').get(run.goal_id) as { status: string; improvement_id: string | null; metadata: string | null } | undefined;
      if (!goal) return 'goal_missing';
      if (goal.status !== 'running') return `goal_${goal.status}`;
      if ((JSON.parse(goal.metadata || '{}') as { operator_paused?: unknown }).operator_paused === true) return 'goal_operator_paused';
      if (goal.improvement_id) {
        const proposal = this.db.prepare('SELECT status FROM self_improvements WHERE id = ?').get(goal.improvement_id) as { status: string } | undefined;
        if (proposal && proposal.status !== 'executing') return `proposal_${proposal.status}`;
      }
      const tasks = this.db.prepare(`SELECT status, json_extract(COALESCE(NULLIF(metadata, ''), '{}'), '$.execution_recovery_hold') AS hold FROM tasks
        WHERE id IN (SELECT json_extract(COALESCE(NULLIF(metadata, ''), '{}'), '$.execution_task_id') FROM worker_leases WHERE loop_run_id = ?)
           OR json_extract(COALESCE(NULLIF(metadata, ''), '{}'), '$.loop_run_id') = ?`).all(run.id, run.id) as Array<{ status: string; hold: unknown }>;
      if (tasks.some((t) => t.hold === 1 || t.hold === true)) return 'execution_recovery_hold';
      if (tasks.some((t) => !['completed', 'failed', 'cancelled'].includes(t.status))) return 'execution_outcome_unknown';
    } catch { return 'state_unreadable'; }
    if (this.leases.listByLoopRun(run.id).some((l) => l.role === 'maker' && l.status === 'completed')) return 'maker_completed';
    return null;
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
