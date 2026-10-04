import type { Database } from 'better-sqlite3';
import { recordAutoApproveShadow, testGapAutoApproveScope } from './autonomy-shadow-service';
import { mutationCheckEnv } from './test-gap-source-service';
import { LoopService } from './loop-service';
import { swarmEventBus } from './swarm-event-bus';
import { GoalDecomposer } from './goal-decomposer';
import { ResourceScheduler } from './resource-scheduler';
import { SwarmIntelligenceService } from './swarm-intelligence-service';
import { KnowledgeRuntimeService } from './knowledge-runtime-service';
import { LoopEventService } from './loop-event-service';
import { inheritableApproval } from './approval-inheritance';
import { CommonsProposalReviewService } from './commons-proposal-review-service';
import { SelfImprovementService } from './self-improvement-service';
import { LoopDraftPrService } from './loop-draft-pr-service';
import { evolveEligible, evolveSpecies, selectEvolveWinner } from './evolve-selection';
import { runGenome } from './maker-genome';
import { strategyGenomeFor } from './genome-registry';
import { banditSpecies, chooseSpecies, speciesKey } from './runtime-bandit';
import { recordFitnessShadow } from './fitness-view';
import { SkillEvolutionEngine } from './skill-evolution-engine';
import { authorityGateForGoal } from './authority-gate';
import { remoteMakerTimeoutMs } from '../execution/executors/remote-maker-executor';
/** Deterministic checks for daemon runs. The repo-wide `test` script cannot finish in 120 s, so hosts can scope it
 *  (LOOP_DAEMON_CHECK_SCRIPTS=test:changed,lint,type-check) and raise the per-script timeout (LOOP_DAEMON_CHECK_TIMEOUT_MS, max 600000). */
export function daemonCheckOptions(env: NodeJS.ProcessEnv = process.env): { scripts?: string[]; timeout_ms: number } {
  const scripts = (env.LOOP_DAEMON_CHECK_SCRIPTS || '').split(',').map((v) => v.trim()).filter(Boolean);
  const timeout = Number(env.LOOP_DAEMON_CHECK_TIMEOUT_MS);
  return { ...(scripts.length ? { scripts } : {}), timeout_ms: Number.isFinite(timeout) && timeout >= 1000 ? Math.min(timeout, 600_000) : 120_000 };
}

/**
 * Maker timeout. Prod 2026-09-25: the first mutation-lane maker (npm ci + two Stryker runs) hit the fixed 300 s; that lane
 * gets the executor maximum (600 s), others LOOP_MAKER_TIMEOUT_MS (default 300 000).
 */
export function daemonMakerTimeoutMs(mutationLane: boolean, env: NodeJS.ProcessEnv = process.env): number {
  if (mutationLane) return 600_000;
  const timeout = Number(env.LOOP_MAKER_TIMEOUT_MS);
  return Number.isFinite(timeout) && timeout >= 1000 ? Math.min(timeout, 600_000) : 300_000;
}

/**
 * A3: a failed run is a regression only when the change was evaluated. Prod 2026-09-25: the first mutation-lane maker hit the
 * timeout in an image without `ps` and its proposal was recorded `regressed`, which the guardrail then counted.
 */
/**
 * U1 follow-up (29-09): of the doc-drift maker's 'regressions' in 30 days most were not about the change — the maker never ran,
 * a check could not find its tool (exit 127: no node_modules, fixed by #514), or the maker changed nothing. Those are now
 * infra_failed / no_change, so the per-class track record (earned autonomy) and the regression guardrail count real failures only.
 */
export function runOutcomeOnFailure(db: Database, makerLeaseId: string): 'regressed' | 'infra_failed' | 'no_change' {
  const lease = db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(makerLeaseId) as { metadata: string } | undefined;
  const meta = JSON.parse(lease?.metadata || '{}') as { failure_reason?: string; timed_out?: boolean; runtime_timed_out?: boolean;
    exit_status?: number | null; completed_at?: string; changed_files?: unknown; deterministic_checks?: Array<{ exit_status?: number | null }> };
  if (meta.timed_out || meta.runtime_timed_out || /runtime_contract/.test(meta.failure_reason ?? '')) return 'infra_failed';
  // EV3 (prod 2026-10-03): a maker that exited non-zero AFTER changing files did the wrong work (30/38 workstation jobs
  // returned README patches) — that is maker quality, not infra; only a non-zero exit without any change is a crash
  if (/maker_runtime_exit_zero/.test(meta.failure_reason ?? '')) return Array.isArray(meta.changed_files) && meta.changed_files.length ? 'regressed' : 'infra_failed';
  if (meta.exit_status === undefined && !meta.completed_at) return 'infra_failed'; // the maker never ran
  if ((meta.deterministic_checks ?? []).some((c) => c?.exit_status === 127)) return 'infra_failed'; // a check's tool was missing
  if (Array.isArray(meta.changed_files) && meta.changed_files.length === 0) return 'no_change';
  return 'regressed';
}

/** Reviewer (checker/security) timeout. Prod 2026-09-24: accepted reviews took 45–119 s; 2/7 reviews hit the old fixed 120 s. */
export function daemonReviewerTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const timeout = Number(env.LOOP_REVIEWER_TIMEOUT_MS);
  return Number.isFinite(timeout) && timeout >= 1000 ? Math.min(timeout, 900_000) : 300_000;
}
import { objectiveModeEnabled, objectiveModeMaxPerTick, goalQualifiesForObjectiveMode } from './objective-loop-gate';

/**
 * G16+G19: ParallelLoopDaemon — continuous + parallel operation mode.
 *
 * Wraps LoopService to run an always-on goal queue. On each tick, loads pending goals,
 * sorts by (risk_class desc, created_at asc), and starts as many as fit within the
 * AIMD controller's available slots (dynamicLimit - activeGoals).
 *
 * Each goal gets its own swarm (maker/checker/nested) in its own worktree. Goals run
 * concurrently — the AIMD controller is the global concurrency gate, bounding the total
 * number of concurrent runtime leases across ALL goals.
 *
 * Goals are submitted via the existing POST /goals endpoint. The daemon polls the
 * queue at GOAL_QUEUE_POLL_MS (default 5000ms).
 *
 * The daemon runs in-process, using the existing continueLoopRun machinery. It
 * starts on server boot (after recoverInterruptedRuns + resumeInterruptedRuns).
 */

interface QueueEntry {
  id: string;
  objective: string;
  risk_class: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export class LoopDaemon {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pollMs: number;
  // G19: track active goals for parallel scheduling.
  private activeGoals = new Set<string>();
  /** Goals with an executeGoal() in flight in this process (activeGoals is persisted and restored, so it can't say that). */
  private executing = new Set<string>();
  // G19: max concurrent goals (separate from AIMD runtime leases — a goal may have
  // multiple leases). Default: min(4, dynamicLimit). Operator-tunable via GOAL_MAX_CONCURRENT.
  private maxConcurrentGoals: number;

  private decomposer: GoalDecomposer;
  private scheduler: ResourceScheduler;

  constructor(
    private db: Database,
    private loops: LoopService,
    opts: { pollMs?: number; maxConcurrentGoals?: number } = {},
  ) {
    this.pollMs = opts.pollMs ?? (Number(process.env.GOAL_QUEUE_POLL_MS) || 5000);
    this.maxConcurrentGoals = opts.maxConcurrentGoals ?? (Number(process.env.GOAL_MAX_CONCURRENT) || 4);
    // G21+G24: goal decomposer + resource scheduler
    const intelligence = new SwarmIntelligenceService(db);
    this.decomposer = new GoalDecomposer(db, loops, intelligence);
    this.scheduler = new ResourceScheduler();
  }

  /**
   * Start the daemon — polls the goal queue at pollMs intervals.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    // G19: restore active goals from system_state on restart.
    this.restoreActiveGoals();
    swarmEventBus.emit('recovery', { daemon: 'started', poll_ms: this.pollMs, max_concurrent: this.maxConcurrentGoals });
    this.tick();
  }

  /**
   * Stop the daemon — cancels the timer.
   */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * G19: Get the number of active (in-flight) goals.
   */
  getActiveGoalCount(): number {
    return this.activeGoals.size;
  }

  /**
   * G19: Get the available slots for new goals.
   */
  getAvailableSlots(): number {
    return Math.max(0, this.maxConcurrentGoals - this.activeGoals.size);
  }

  /**
   * Process one tick: load pending goals, start as many as fit in available slots.
   * Each goal is started asynchronously (non-blocking) — the tick continues to the
   * next goal without waiting for the previous one to finish.
   */
  async tick(): Promise<void> {
    // Allow tick to run even when not started (for testing)
    this.pruneWorktrees();

    try {
      this.resumeApprovalBlockedGoals();
      const queue = this.loadQueue();
      if (queue.length === 0) {
        this.scheduleNext();
        return;
      }

      // G19: start as many goals as fit in the available slots.
      const slots = this.getAvailableSlots();
      // prod 2026-10-01: a goal resumed after an approval is 'decomposed' while it runs, so every tick dispatched it again;
      // the second pass found the running evolve sibling and failed the goal with LOOP_WORKER_EXECUTION_IN_PROGRESS
      const toStart = queue.filter((g) => !this.executing.has(g.id)).slice(0, slots);
      let objectiveModeDispatchedThisTick = 0;

      for (const goal of toStart) {
        // G3.4 authority gate (fail-closed; flag AUTHORITY_GATE).
        const authorityGateResult =
          authorityGateForGoal(this.db, goal);
        if (!authorityGateResult.allowed) {
          console.error(
            '[LoopDaemon] goal geweigerd door authority-gate:',
            goal.id, '-', authorityGateResult.reason,
          );
          swarmEventBus.emit('authority_deny', {
            goal_id: goal.id,
            reason: authorityGateResult.reason,
            mode: authorityGateResult.mode,
          });
          continue;
        }
        if (authorityGateResult.mode !== 'off') {
          swarmEventBus.emit('authority_gate', {
            goal_id: goal.id,
            reason: authorityGateResult.reason,
            mode: authorityGateResult.mode,
          });
        }
        // originele loop-body volgt hieronder


        // Objective-mode dispatch decision: whether this goal reaches a real
        // maker/checker cycle driven by its own objective, instead of the
        // safe doc-drift-and-small-fix-loop no-op. Deliberately conservative:
        // requires the flag, a qualifying goal (self-improvement source,
        // risk_class 'low'), and the per-tick cap not yet reached.
        //
        // Originally also required AUTHORITY_GATE=enforce as a
        // belt-and-suspenders condition, but that flag isn't scoped to this
        // feature — authorityGateForGoal() runs for every goal the daemon
        // processes, and fail-closes ALL goal execution (not just
        // self-improvement) when the authority_events table is missing,
        // which it is in every environment this has been checked against.
        // Dropped after finding this would have halted the entire daemon,
        // not just gated this feature — see PR history.
        const qualification = goalQualifiesForObjectiveMode(goal);
        const capped = objectiveModeDispatchedThisTick >= objectiveModeMaxPerTick();
        // A qualifying goal that only lost the per-tick cap must WAIT for the next tick. It used to fall through to the
        // doc-drift no-op, which "completed with no changes required" and marked its proposal no_change (2026-09-22: a
        // valid test-gap proposal was wasted this way, and the system learned a wrong lesson from it).
        if (objectiveModeEnabled() && qualification.qualifies && capped) {
          swarmEventBus.emit('convergence', { daemon: 'objective_mode_decision', goal_id: goal.id, allowed: false, reason: 'deferred_per_tick_cap', enabled: true });
          continue;
        }
        const allowObjectiveMode = objectiveModeEnabled() && qualification.qualifies && !capped;
        if (allowObjectiveMode) objectiveModeDispatchedThisTick += 1;

        // Mark goal as active + start it asynchronously.
        this.activeGoals.add(goal.id);
        this.persistActiveGoals();

        // Observability: log every self-improvement goal's dispatch decision,
        // not just the ones that succeed — closes the exact blind spot that
        // let 10/10 goals silently produce identical doc-drift no-ops.
        if (qualification.qualifies || objectiveModeEnabled()) {
          swarmEventBus.emit('convergence', {
            daemon: 'objective_mode_decision',
            goal_id: goal.id,
            allowed: allowObjectiveMode,
            reason: allowObjectiveMode
              ? 'dispatched'
              : capped ? 'per_tick_cap_reached'
              : qualification.reason,
            enabled: objectiveModeEnabled(),
          });
        }

        // Non-blocking: start the goal and don't wait for it to finish.
        this.executing.add(goal.id);
        this.executeGoal(goal, { allowObjectiveMode }).catch((err) => {
          console.error('[LoopDaemon] goal execution error:', err instanceof Error ? err.message : String(err));
        }).finally(() => this.executing.delete(goal.id));
      }

      if (toStart.length > 0) {
        swarmEventBus.emit('convergence', {
          daemon: 'tick_processed',
          started: toStart.length,
          active: this.activeGoals.size,
          available_slots: this.getAvailableSlots(),
        });
      }
    } catch (error) {
      console.error('[LoopDaemon] tick error:', error instanceof Error ? error.message : String(error));
    }

    this.scheduleNext();
  }

  /**
   * The execution engine asks a human before a worker runs (approval policy). That is a wait, not a failure:
   * the goal used to be marked failed and its proposal parked (the approval then expired unseen, 2026-09-21).
   * Park the goal as 'blocked' with what it waits for; resumeApprovalBlockedGoals() continues or fails it.
   */
  private blockForApproval(goal: QueueEntry, runId: string, role: 'maker' | 'checker' | 'security_checker' = 'maker'): boolean {
    const lease = this.db.prepare("SELECT id, metadata FROM worker_leases WHERE loop_run_id = ? AND role = ? ORDER BY created_at DESC LIMIT 1").get(runId, role) as { id: string; metadata: string } | undefined;
    const leaseMeta = lease ? (JSON.parse(lease.metadata || '{}') as { approval_id?: string; execution_task_id?: string }) : {};
    // The engine records the approval on the task; not every lease path copies it onto the lease metadata (the checker's doesn't).
    const approvalId = leaseMeta.approval_id
      ?? (leaseMeta.execution_task_id
        ? (this.db.prepare('SELECT id FROM approvals WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(leaseMeta.execution_task_id) as { id: string } | undefined)?.id
        : undefined);
    if (!lease || !approvalId) return false; // cannot resume without knowing what to wait for: fail as before
    const waiting = { approval_id: approvalId, run_id: runId, lease_id: lease.id, since: new Date().toISOString() };
    this.db.prepare("UPDATE goals SET status = 'blocked', metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.awaiting_approval', json(?)), updated_at = ? WHERE id = ?")
      .run(JSON.stringify(waiting), new Date().toISOString(), goal.id);
    try {
      new LoopEventService(this.db).recordEvent(runId, 'goal_awaiting_approval', 'warning', `Waiting for human approval ${approvalId}`, { goal_id: goal.id, approval_id: approvalId });
    } catch { /* best-effort */ }
    const shadow = recordAutoApproveShadow(this.db, goal.id, runId, approvalId); // plan E3: the rule; approves only via J5 below
    // Z4 (plan Phase Z, operator decision 01-10): rule-v1 says 'no' to the whole class after any regression and to keyword
    // 'high risk' (prod 01-10: 8/8 oracle-lane makers went to the human). With ORACLE_LANES_AUTO_APPROVE=true an oracle-lane
    // maker is approved on its deterministic one-test-file scope; the scope gate, checks, oracle and human merge stay, and
    // the rule's verdict is still recorded.
    const oracleLane = process.env.ORACLE_LANES_AUTO_APPROVE === 'true' && shadow?.decision !== 'yes';
    const scope = role === 'maker' && (shadow?.decision === 'yes' || oracleLane) ? testGapAutoApproveScope(this.db, goal.id) : null;
    if (scope) {
      const why = oracleLane ? `Z4 oracle lane, scope ${scope}${shadow ? `; rule-v1: ${shadow.reason}` : ''}` : shadow!.reason;
      // Record the scope before approving: the maker resumes right after, and verification needs it to hold the diff to one file.
      this.db.prepare("UPDATE worker_leases SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.auto_approved_scope', ?) WHERE id = ?").run(scope, lease.id);
      try { new LoopEventService(this.db).recordEvent(runId, 'goal_auto_approved', 'info', `Auto-approved ${approvalId} (${oracleLane ? 'oracle lane' : 'test-gap lane'}, scope ${scope})`, { goal_id: goal.id, approval_id: approvalId, reason: why }); } catch { /* best-effort */ }
      this.loops.decideWorkerApproval(approvalId, true, oracleLane ? 'autonomy:oracle-lane-v1' : 'autonomy:test-gap-rule-v1', why)
        .catch((err: unknown) => console.warn(`[loop-daemon] auto-approve ${approvalId} failed:`, err instanceof Error ? err.message : String(err)));
    }
    console.warn(`[loop-daemon] goal ${goal.id} waits for approval ${approvalId} (run ${runId})`);
    swarmEventBus.emit('convergence', { daemon: 'goal_awaiting_approval', goal_id: goal.id, run_id: runId, approval_id: approvalId });
    return true;
  }

  /** N6: approve an evolve sibling when the run's first maker was auto-approved (J5), with the same scope. */
  private async autoApproveSibling(runId: string, primaryLeaseId: string, siblingLeaseId: string): Promise<boolean> {
    const lease = (id: string) => this.db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(id) as { metadata: string } | undefined;
    const scope = (JSON.parse(lease(primaryLeaseId)?.metadata || '{}') as { auto_approved_scope?: string }).auto_approved_scope;
    const meta = JSON.parse(lease(siblingLeaseId)?.metadata || '{}') as { approval_id?: string; execution_task_id?: string };
    const approvalId = meta.approval_id ?? (meta.execution_task_id
      ? (this.db.prepare("SELECT id FROM approvals WHERE task_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(meta.execution_task_id) as { id: string } | undefined)?.id
      : undefined);
    if (!scope || !approvalId) return false;
    this.db.prepare("UPDATE worker_leases SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.auto_approved_scope', ?) WHERE id = ?").run(scope, siblingLeaseId);
    try { new LoopEventService(this.db).recordEvent(runId, 'goal_auto_approved', 'info', `Auto-approved evolve sibling ${approvalId} (scope ${scope})`, { approval_id: approvalId, sibling_lease_id: siblingLeaseId }); } catch { /* logging */ }
    await this.loops.decideWorkerApproval(approvalId, true, 'autonomy:test-gap-rule-v1', `evolve sibling of auto-approved maker ${primaryLeaseId}`);
    return true;
  }

  /** D4: approve a retry/sibling maker's pending approval only when approval-inheritance's strict rule holds; recorded as an event. */
  private async inheritApproval(runId: string, leaseId: string): Promise<boolean> {
    const meta = JSON.parse((this.db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(leaseId) as { metadata: string } | undefined)?.metadata || '{}') as { approval_id?: string; execution_task_id?: string };
    const approvalId = meta.approval_id ?? (meta.execution_task_id
      ? (this.db.prepare("SELECT id FROM approvals WHERE task_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(meta.execution_task_id) as { id: string } | undefined)?.id
      : undefined);
    const inherit = approvalId ? inheritableApproval(this.db, approvalId, runId) : null;
    if (!approvalId || !inherit) return false;
    try { new LoopEventService(this.db).recordEvent(runId, 'approval_inherited', 'info', inherit.reason, { approval_id: approvalId, inherited_from: inherit.originalId, lease_id: leaseId }); } catch { /* logging */ }
    await this.loops.decideWorkerApproval(approvalId, true, `inherit:${inherit.originalId}`, inherit.reason);
    return true;
  }

  /** approved + task finished -> requeue the goal on its existing run; denied/expired -> fail it. Otherwise keep waiting. */
  private resumeApprovalBlockedGoals(): void {
    const rows = this.db.prepare("SELECT id, metadata FROM goals WHERE status = 'blocked' AND json_extract(metadata, '$.awaiting_approval') IS NOT NULL").all() as Array<{ id: string; metadata: string }>;
    for (const row of rows) {
      const waiting = (JSON.parse(row.metadata || '{}') as { awaiting_approval?: { approval_id: string; run_id: string; lease_id: string } }).awaiting_approval;
      if (!waiting) continue;
      const approval = this.db.prepare('SELECT status, task_id FROM approvals WHERE id = ?').get(waiting.approval_id) as { status: string; task_id: string } | undefined;
      const now = new Date().toISOString();
      if (!approval || approval.status === 'pending') continue;
      if (approval.status === 'approved') {
        // Approving resumes the task inside the engine; continue only once it reached a terminal state, then
        // executeViaEngine returns the stored result instead of running the maker twice.
        const task = this.db.prepare('SELECT status FROM tasks WHERE id = ?').get(approval.task_id) as { status: string } | undefined;
        if (!task || !['completed', 'failed', 'cancelled'].includes(task.status)) continue;
        this.db.prepare("UPDATE goals SET status = 'decomposed', metadata = json_set(json_remove(metadata, '$.awaiting_approval'), '$.resume_run_id', ?), updated_at = ? WHERE id = ?")
          .run(waiting.run_id, now, row.id);
        continue;
      }
      // denied | expired: the human gate said no (or nobody answered in time)
      this.db.prepare("UPDATE goals SET status = 'failed', metadata = json_remove(metadata, '$.awaiting_approval'), updated_at = ? WHERE id = ?").run(now, row.id);
      const reason = `approval ${approval.status}`;
      try { new LoopEventService(this.db).recordEvent(waiting.run_id, 'goal_failed', 'error', reason, { goal_id: row.id, approval_id: waiting.approval_id }); } catch { /* best-effort */ }
      try { new CommonsProposalReviewService(this.db).recordGoalOutcome(row.id, 'failed', reason); } catch { /* best-effort learning */ }
      swarmEventBus.emit('loop_completed', { loopRunId: waiting.run_id, goalId: row.id, goalType: 'doc-drift-and-small-fix-loop', mode: 'closed', status: 'failed', durationMs: 0, strategy: 'objective', startedAt: now, completedAt: now });
    }
  }

  private scheduleNext(): void {
    // Allow tick to run even when not started (for testing)
    this.timer = setTimeout(() => this.tick(), this.pollMs);
  }

  /**
   * Load pending goals sorted by (risk desc, created_at asc).
   */
  private loadQueue(): QueueEntry[] {
    const rows = this.db.prepare(`
      SELECT id, objective, risk_class, metadata, created_at
      FROM goals
      WHERE status IN ('created', 'decomposed')
      ORDER BY
        CASE risk_class
          WHEN 'critical' THEN 4
          WHEN 'high' THEN 3
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 1
          ELSE 0
        END DESC,
        created_at ASC
    `).all() as QueueEntry[];

    return rows.map((r) => ({
      ...r,
      metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata || '{}') : r.metadata,
    }));
  }

  /**
   * Execute a single goal: decompose → start loop → continue (execute workers) → certify → learn.
   * This is the FULLY AUTONOMOUS execution path — no manual intervention needed.
   * The daemon discovers findings, creates leases, executes the maker+checker, runs
   * deterministic checks, and certifies the result.
   */
  private async executeGoal(goal: QueueEntry, opts: { allowObjectiveMode: boolean } = { allowObjectiveMode: false }): Promise<void> {
    let runId: string | null = null;
    const startedAtMs = Date.now();
    // The cognitive/meta layer keys tuning by the run's loop name (loop-service getActiveLoopTuning), not by execution mode.
    let loopName = 'doc-drift-and-small-fix-loop';
    const executionMode = opts.allowObjectiveMode ? 'objective' : 'doc_drift';
    try {
      // 1. Decompose the goal if not already decomposed.
      const currentStatus = this.db.prepare('SELECT status FROM goals WHERE id = ?').get(goal.id) as { status: string } | undefined;
      if (currentStatus?.status === 'created') {
        const canSchedule = this.scheduler.canSchedule(goal.metadata);
        if (!canSchedule.canSchedule) {
          swarmEventBus.emit('convergence', {
            daemon: 'goal_deferred',
            goal_id: goal.id,
            reason: canSchedule.reason,
          });
          this.activeGoals.delete(goal.id);
          this.persistActiveGoals();
          return;
        }
        this.decomposer.decomposeGoalToDAG(goal.id);
      }

      // 2. Start the loop (discovers findings, creates the loop_run). A
      // qualifying self-improvement goal reaches a real maker/checker cycle
      // driven by its own objective instead of the safe doc-drift no-op —
      // see objective-loop-gate.ts for the dispatch decision made in tick().
      const resumeRunId = typeof goal.metadata?.resume_run_id === 'string' ? goal.metadata.resume_run_id : null;
      const run = resumeRunId
        ? this.loops.getLoopRun(resumeRunId) // approved: continue the same run, its maker lease is prepared
        : opts.allowObjectiveMode
        // Objective mode needs a real git checkout to create worktrees; process.cwd() is /app in the
        // production image (not a repository). LOOP_DAEMON_REPOSITORY_PATH points at the checkout.
        ? this.loops.startObjectiveLoop({ goal_id: goal.id, ...(process.env.LOOP_DAEMON_REPOSITORY_PATH ? { repository_path: process.env.LOOP_DAEMON_REPOSITORY_PATH } : {}) })
        : this.loops.startDocDriftAndSmallFixLoop({ goal_id: goal.id });
      runId = run.id;
      loopName = (run as { loop_name?: string }).loop_name ?? loopName;

      // 3. Skip execution if no findings were discovered.
      if (run.findings.length === 0) {
        this.db.prepare('UPDATE goals SET status = ?, updated_at = ? WHERE id = ?')
          .run('completed', new Date().toISOString(), goal.id);
        swarmEventBus.emit('convergence', {
          daemon: 'goal_completed',
          goal_id: goal.id,
          run_id: run.id,
          reason: 'no findings — goal completed (nothing to fix)',
          execution_mode: executionMode,
        });
        return;
      }

      swarmEventBus.emit('convergence', {
        daemon: 'goal_started',
        goal_id: goal.id,
        run_id: run.id,
        objective: goal.objective,
        active_goals: this.activeGoals.size,
        execution_mode: executionMode,
      });

      // 4. Continue the loop — creates maker+checker leases (prepared status).
      // G28+G33: the planner selects the runtime per finding based on per-runtime
      // competence (not hardcoded 'codex'). The plan is produced inside continueLoopRun.
      // A maker runtime is never inferred from a recommendation (loop-lifecycle-service): without an explicit
      // one the lease is 'manual' and every daemon goal died with MANUAL_MAKER_REQUIRES_HUMAN (seen in the
      // 2026-09-21 loop proof). LOOP_DAEMON_MAKER_RUNTIME is the operator's explicit choice, objective mode only.
      const makerRuntime = opts.allowObjectiveMode ? (process.env.LOOP_DAEMON_MAKER_RUNTIME as 'codex' | 'opencode' | 'claude' | 'gemini' | 'editor' | 'pi' | 'mock' | undefined) : undefined;
      const prepared = resumeRunId
        ? { run, leases: this.loops.listWorkerLeases(run.id) }
        : this.loops.continueLoopRun(run.id, {
          max_assignments: 1,
          max_maker_workers: 1,
          ...(makerRuntime ? { runtime: makerRuntime } : {}),
        });

      // 5. Find the prepared maker lease and execute it.
      // A run resumed after the checker's approval already has a completed maker: don't run it twice.
      // Y0b: a run resumed after an evolve sibling's approval runs that sibling (and ranks it below), even when the first
      // maker already completed — before, a completed first maker hid the approved sibling, or the sibling was dropped
      const pendingSibling = resumeRunId
        ? prepared.leases.find(l => l.role === 'maker' && l.status === 'prepared' && typeof l.metadata?.evolve_sibling_of === 'string')
        : undefined;
      const makerAlreadyDone = resumeRunId && !pendingSibling ? prepared.leases.find(l => l.role === 'maker' && l.status === 'completed') : undefined;
      const makerLease = makerAlreadyDone ?? pendingSibling ?? prepared.leases.find(l => l.role === 'maker' && l.status === 'prepared');
      if (!makerLease) {
        throw new Error('No prepared maker lease found after continueLoopRun');
      }

      // 5b. E12 (LOOP_BANDIT_ENABLED): the maker species is chosen by outcome — Thompson over skill_outcomes, challengers
      // capped until they have enough runs. Y1 (operator 2026-10-01): with the bandit on it also chooses over
      // LOOP_DAEMON_MAKER_RUNTIME, which stays on the lease as the fallback when the bandit makes no choice.
      // Never on a resumed evolve sibling: its species is the point of the sibling (prod 2026-10-01: the bandit rewrote
      // remote@workstation siblings to opencode, which then ran the task twice and drifted into README/CONTRIBUTING edits).
      if (!makerAlreadyDone && !pendingSibling && (!makerRuntime || process.env.LOOP_BANDIT_ENABLED === 'true')) {
        const choice = chooseSpecies(this.db, loopName, banditSpecies());
        // D0 shadow: what a source-weighted, decaying fitness view (production + gym + merge survival) would have picked
        try { recordFitnessShadow(this.db, run.id, loopName, banditSpecies(), choice ? speciesKey(choice.species) : null); } catch { /* telemetry only */ }
        if (choice) {
          try {
            this.loops.assertRuntimeAvailable(choice.species.runtime);
            this.db.prepare(`UPDATE worker_leases SET runtime = ?, metadata = json_set(json_remove(COALESCE(metadata, '{}'), '$.model'), '$.bandit', json(?))
              WHERE id = ? AND status = 'prepared'`).run(choice.species.runtime, JSON.stringify({ reason: choice.reason, posterior: choice.posterior }), makerLease.id);
            if (choice.species.model) this.db.prepare(`UPDATE worker_leases SET metadata = json_set(metadata, '$.model', ?) WHERE id = ?`).run(choice.species.model, makerLease.id);
            (makerLease as { runtime: string }).runtime = choice.species.runtime;
            new LoopEventService(this.db).recordEvent(run.id, 'bandit_selected', 'info', `Maker species ${speciesKey(choice.species)}: ${choice.reason}`, { posterior: choice.posterior });
          } catch (error) {
            try { new LoopEventService(this.db).recordEvent(run.id, 'bandit_skipped', 'warning', `Bandit choice ${speciesKey(choice.species)} not applied: ${error instanceof Error ? error.message : String(error)}`, {}); } catch { /* logging */ }
          }
        }
      }

      // D2: attribute the maker to its strategy genome (lease stamp → outcomes, merge survival); GENOME_APPLY_MODE=shadow logs
      // what an active genome would inject. Injecting is a separate, operator-owned flag (not built here).
      if (!makerAlreadyDone) try {
        const lease = this.db.prepare('SELECT runtime, json_extract(metadata, \'$.model\') AS model FROM worker_leases WHERE id = ?').get(makerLease.id) as { runtime: string; model: string | null } | undefined;
        const strategy = lease ? strategyGenomeFor(this.db, lease.runtime, lease.model) : null;
        if (strategy) {
          this.db.prepare("UPDATE worker_leases SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.genome_id', ?) WHERE id = ?").run(strategy.id, makerLease.id);
          if (process.env.GENOME_APPLY_MODE === 'shadow' && strategy.lines.length) new LoopEventService(this.db).recordEvent(run.id, 'genome_apply_shadow', 'info',
            `Genome ${strategy.id} would add ${strategy.lines.length} strategy line(s) to this maker`, { genome_id: strategy.id, lines: strategy.lines, maker_lease_id: makerLease.id });
        }
      } catch { /* attribution is best-effort */ }

      // 6. Execute the maker (runs the runtime — codex/opencode/pi).
      const mutationLane = Object.keys(mutationCheckEnv(this.db, goal.id)).length > 0;
      const makerTimeout = daemonMakerTimeoutMs(mutationLane);
      // strengthening a thin test to kill surviving mutants legitimately adds more lines (prod: 23-line test → 276 diff lines)
      const makerDiffMax = mutationLane ? 400 : 200;
      if (!makerAlreadyDone) await this.loops.executeWorker(run.id, {
        lease_id: makerLease.id,
        timeout_ms: makerTimeout,
        diff_max_lines: makerDiffMax,
        skip_permissions: Boolean(process.env.RUNTIME_ALLOW_SKIP_PERMISSIONS),
      });

      // 7. Run deterministic checks (test, lint, type-check).
      let activeMakerLease = makerLease;
      try {
        const checks = this.loops.runDeterministicChecks(run.id, {
          lease_id: makerLease.id,
          ...daemonCheckOptions(),
        });

        // 8. If checks fail, retry once (G3 feedback law).
        if (checks.run.status === 'blocked') {
          try {
            const retry = this.loops.retryLoopRun(run.id, { maker_lease_id: makerLease.id });
            const retryMaker = retry.retry_maker;
            const retryInput = { lease_id: retryMaker.id, timeout_ms: makerTimeout, diff_max_lines: makerDiffMax, skip_permissions: Boolean(process.env.RUNTIME_ALLOW_SKIP_PERMISSIONS) };
            try {
              await this.loops.executeWorker(run.id, retryInput);
            } catch (error) {
              // a retry needs its own approval; it used to be dropped here silently. D4: inherit only under the strict rule.
              if (!/APPROVAL_REQUIRED/.test(error instanceof Error ? error.message : String(error)) || !(await this.inheritApproval(run.id, retryMaker.id))) throw error;
              await this.loops.awaitWorkerExecution(retryMaker.id);
              await this.loops.executeWorker(run.id, retryInput);
            }
            this.loops.runDeterministicChecks(run.id, {
              lease_id: retryMaker.id,
              ...daemonCheckOptions(),
            });
            activeMakerLease = retryMaker;
          } catch { /* best-effort retry */ }
        }
      } catch { /* best-effort: checks are not fatal for the daemon */ }

      // 8a. Evolve (E13, LOOP_EVOLVE_ENABLED, test-gap goals only): sibling makers of other species on the same objective;
      // the fittest (computed in code) stays the only non-superseded maker and goes on to the reviewers.
      // Y1: never a sibling of the species the bandit already chose as the first maker (it would run the same work twice)
      const primary = this.db.prepare("SELECT runtime, json_extract(metadata, '$.model') AS model FROM worker_leases WHERE id = ?").get(makerLease.id) as { runtime: string; model: string | null } | undefined;
      const species = (!makerAlreadyDone && !pendingSibling && evolveEligible(this.db, goal.id) ? evolveSpecies() : [])
        .filter((sp) => !(primary && sp.runtime === primary.runtime && (sp.model ?? null) === (primary.model ?? null)));
      if (species.length) {
        const contenders = [activeMakerLease.id];
        for (const sp of species) {
          try {
            const sibling = this.loops.retryLoopRun(run.id, { maker_lease_id: makerLease.id, sibling: true, runtime: sp.runtime as never, ...(sp.model ? { model: sp.model } : {}) }).retry_maker;
            // Ranked even if it crashes below: creating it superseded the first maker, and selection must be able to undo that.
            contenders.push(sibling.id);
            const siblingInput = { lease_id: sibling.id, timeout_ms: makerTimeout, diff_max_lines: makerDiffMax, skip_permissions: Boolean(process.env.RUNTIME_ALLOW_SKIP_PERMISSIONS) };
            try {
              await this.loops.executeWorker(run.id, siblingInput);
            } catch (error) {
              // N6: a sibling is a maker, so it needs its own approval and used to fail here every time. In an auto-approved
              // lane (J5) it gets the same one-file scope and the same rule decision; anywhere else it still fails.
              if (!/APPROVAL_REQUIRED/.test(error instanceof Error ? error.message : String(error))
                || !((await this.autoApproveSibling(run.id, makerLease.id, sibling.id)) || (await this.inheritApproval(run.id, sibling.id)))) throw error;
              // a remote host may take up to REMOTE_MAKER_TIMEOUT_MS; the 11-min default gave up on both first workstation
              // makers (prod 2026-09-27: patches arrived at +13 and +26 min, after the run was already blocked)
              // prod 2026-10-01: right after an automatic approval the engine had not yet marked the sibling's task running,
              // so the wait returned at once and the read-back hit LOOP_WORKER_EXECUTION_IN_PROGRESS — 4/4 goals failed while
              // their runs went on. An execution in progress is waited for (bounded), not a failure.
              for (let attempt = 0; ; attempt++) {
                await this.loops.awaitWorkerExecution(sibling.id, sp.runtime === 'remote' ? remoteMakerTimeoutMs() + 60_000 : undefined);
                try { await this.loops.executeWorker(run.id, siblingInput); break; } // returns the result of the approved execution
                catch (waitError) {
                  if (attempt >= 3 || !/LOOP_WORKER_EXECUTION_IN_PROGRESS/.test(waitError instanceof Error ? waitError.message : String(waitError))) throw waitError;
                }
              }
            }
            this.loops.runDeterministicChecks(run.id, { lease_id: sibling.id, ...daemonCheckOptions() });
          } catch (error) {
            // Y0b (prod 2026-09-30 16:17/18:29): a sibling that still needs a human approval is not a failed sibling — the
            // run used to conclude 'no winner' at once and the approval arrived after the proposal was labelled regressed.
            // Propagate it: executeGoal parks the goal on that approval, and the resumed run ranks the sibling.
            if (/APPROVAL_REQUIRED/.test(error instanceof Error ? error.message : String(error))) throw error;
            try { new LoopEventService(this.db).recordEvent(run.id, 'evolve_sibling_failed', 'warning', `Evolve sibling ${sp.runtime}${sp.model ? `@${sp.model}` : ''} failed: ${error instanceof Error ? error.message : String(error)}`, { goal_id: goal.id }); } catch { /* logging */ }
          }
        }
        const winnerId = contenders.length > 1 ? selectEvolveWinner(this.db, run.id, contenders) : null;
        const winner = winnerId ? this.db.prepare('SELECT * FROM worker_leases WHERE id = ?').get(winnerId) as typeof activeMakerLease | undefined : undefined;
        if (winner) activeMakerLease = { ...activeMakerLease, id: winner.id, runtime: winner.runtime };
      } else if (pendingSibling) {
        // Y0b: the approved sibling just ran; rank it against the makers of the first pass instead of spawning new siblings
        const contenders = prepared.leases.filter(l => l.role === 'maker').map(l => l.id);
        const winnerId = contenders.length > 1 ? selectEvolveWinner(this.db, run.id, contenders) : null;
        const winner = winnerId ? this.db.prepare('SELECT * FROM worker_leases WHERE id = ?').get(winnerId) as typeof activeMakerLease | undefined : undefined;
        if (winner) activeMakerLease = { ...activeMakerLease, id: winner.id, runtime: winner.runtime };
      }

      // 8b. Dispatch the checker — gated, off by default. Checker leases are
      // always created with runtime:'manual' (loop-lifecycle-service.ts),
      // independent of whatever runtime the maker used — by design, code
      // review requires a human today. Without this, no maker-completed run
      // has ever had an accepted checker verdict: verifyLoopRun()'s
      // checker_verdict gate could never pass, allGatesPass was always
      // false, and closeLoop() (gated on allGatesPass) was never even
      // reached — the real reason loop_learning_closures stayed near-empty.
      // Found 2026-09-20/21, and explicitly confirmed with the user this is
      // a real autonomy expansion (removes human review from verification),
      // not a bug fix — so it stays off unless LOOP_DAEMON_AUTOMATED_CHECKER_ENABLED
      // is set, using the same runtime as whichever maker attempt actually
      // ran (self-review, not an independent reviewer — the simplest
      // automatable option, chosen deliberately over inventing a second
      // "reviewer runtime" concept). executeChecker() already auto-discovers
      // the current prepared checker lease (correctly picking up a retry's
      // checker lease) and already writes the real checkpoint/trace-span/
      // manifest evidence closeLoop() requires — no new writer needed.
      if (process.env.LOOP_DAEMON_AUTOMATED_CHECKER_ENABLED === 'true') {
        const runtime = activeMakerLease.runtime as 'codex' | 'opencode' | 'claude' | 'gemini' | 'editor' | 'pi' | 'mock';
        const leaseDone = (role: string) => Boolean(this.db.prepare("SELECT 1 FROM worker_leases WHERE loop_run_id = ? AND role = ? AND status = 'completed' LIMIT 1").get(run.id, role));
        const dispatch = async (role: 'checker' | 'security_checker', leaseId?: string): Promise<boolean> => {
          try {
            await this.loops.executeChecker(run.id, { ...(leaseId ? { lease_id: leaseId } : {}), runtime, timeout_ms: daemonReviewerTimeoutMs() });
          } catch (error) {
            // A reviewer is a worker too: the execution engine asks a human before it runs. That is a wait, not a failure
            // (previously swallowed here, so the run was verified without a verdict and failed).
            if (error instanceof Error && error.message === 'LOOP_WORKER_APPROVAL_REQUIRED' && this.blockForApproval(goal, run.id, role)) return true;
            // Best-effort otherwise (verifyLoopRun's verdict gates reflect reality below) — but never silently:
            // a swallowed dispatch error made the 2026-09-21 loop proof undiagnosable.
            try {
              new LoopEventService(this.db).recordEvent(run.id, 'checker_dispatch_failed', 'warning',
                `Automated ${role} dispatch failed: ${error instanceof Error ? error.message : String(error)}`, { goal_id: goal.id });
            } catch { /* logging must never break the daemon */ }
          }
          return false;
        };
        // A run resumed after a reviewer's approval already has the earlier reviewer's verdict: don't dispatch it twice.
        if (!leaseDone('checker') && await dispatch('checker')) return;
        // The security reviewer is a separate, higher autonomy step (removes human security review): its own flag.
        if (process.env.LOOP_DAEMON_AUTOMATED_SECURITY_CHECKER_ENABLED === 'true' && !leaseDone('security_checker')) {
          const security = this.db.prepare("SELECT id FROM worker_leases WHERE loop_run_id = ? AND role = 'security_checker' AND status = 'prepared' ORDER BY created_at DESC LIMIT 1").get(run.id) as { id: string } | undefined;
          if (security && await dispatch('security_checker', security.id)) return;
        }
      }

      // 9-. A reviewer still running belongs to another pass over this run (e.g. an approval resume); verifying now
      // fails its verdict gate and records a false 'regressed'. That pass verifies when its reviewer finishes.
      const reviewerRunning = this.db.prepare("SELECT 1 FROM worker_leases WHERE loop_run_id = ? AND role IN ('checker', 'security_checker') AND status = 'running' LIMIT 1").get(run.id);
      if (reviewerRunning) {
        try {
          new LoopEventService(this.db).recordEvent(run.id, 'verify_deferred', 'info', 'Verification deferred: a reviewer lease is still running.', { goal_id: goal.id });
        } catch { /* logging must never break the daemon */ }
        return;
      }

      // 9. Verify the run (G3.4 convergence verification).
      const verification = this.loops.verifyLoopRun(run.id);
      const allGatesPass = verification.gates.length > 0 && verification.gates.every(g => g.status === 'pass');

      // 9a. Feed the cognitive layer: it only learns from 'loop_completed' bus events, which were
      // previously sent solely by the human-approval completeLoopRun() route — so it stayed at 0
      // episodes. Emit one per executed run (recordEpisode dedupes on loopRunId).
      swarmEventBus.emit('loop_completed', {
        loopRunId: run.id,
        goalId: goal.id,
        goalType: loopName,
        mode: 'closed',
        status: allGatesPass ? 'completed' : 'failed',
        durationMs: Date.now() - startedAtMs,
        strategy: executionMode,
        startedAt: new Date(startedAtMs).toISOString(),
        completedAt: new Date().toISOString(),
      });

      // 9a'. What the run achieved is the proposal's outcome (feeds the source bandit + panel calibration).
      try {
        const linked = this.db.prepare('SELECT improvement_id FROM goals WHERE id = ?').get(goal.id) as { improvement_id: string | null } | undefined;
        if (linked?.improvement_id) new SelfImprovementService(this.db).recordOutcome(linked.improvement_id, allGatesPass ? 'verified' : runOutcomeOnFailure(this.db, activeMakerLease.id));
      } catch { /* best-effort learning */ }

      // 9a''. Heritability (E10): each run is one outcome of its maker "skill" (loop × runtime) — the fitness signal the
      // skill-evolution engine and a later runtime bandit select on. Before this, skill_outcomes only got manual API writes.
      try {
        const maker = this.db.prepare('SELECT id, runtime, metadata FROM worker_leases WHERE id = ?').get(activeMakerLease.id) as { id: string; runtime: string; metadata: string } | undefined;
        const meta = maker ? JSON.parse(maker.metadata || '{}') as { model?: unknown; genome_id?: unknown; runtime_usage?: { total_tokens?: unknown } } : {};
        const skills = new SkillEvolutionEngine(this.db); // ensures skill_outcomes exists
        const skillId = `loop-maker:${loopName}:${activeMakerLease.runtime}`;
        // Y2: the strategy genome this maker ran with (template + examples + sealed rules), on the lease and the outcome
        const genome = runGenome(this.db, run.id);
        this.db.prepare("UPDATE worker_leases SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.genome', json(?)) WHERE id = ?").run(JSON.stringify(genome), activeMakerLease.id);
        // One outcome per run: two daemon passes can finish the same run.
        if (!this.db.prepare('SELECT 1 FROM skill_outcomes WHERE skill_id = ? AND task_id = ? AND agent_id = ? LIMIT 1').get(skillId, run.id, activeMakerLease.id)) skills.recordOutcome(skillId, {
          success: allGatesPass,
          tokensUsed: Number(meta.runtime_usage?.total_tokens) || 0,
          durationMs: Date.now() - startedAtMs,
          domain: loopName,
          taskId: run.id,
          agentId: activeMakerLease.id,
          ...(typeof meta.model === 'string' ? { model: meta.model } : {}),
          evidenceRefs: [`loop_run:${run.id}`, `genome:${genome.id}`, ...(typeof meta.genome_id === 'string' ? [`strategy_genome:${meta.genome_id}`] : []), ...verification.gates.filter(g => g.status !== 'pass').map(g => `gate:${g.name}:${g.status}`)],
        });
      } catch { /* best-effort learning */ }

      // 9b. Close learning loop (reflection + memory + follow-up).
      if (allGatesPass) {
        try { new CommonsProposalReviewService(this.db).recordGoalOutcome(goal.id, 'completed', `run ${run.id} certified`); } catch { /* best-effort learning */ }
        // G4: hand verified work to a human as a draft PR (default off; records draft_pr_failed on any problem).
        try { await new LoopDraftPrService(this.db).openForRun(run.id); } catch { /* never fail the daemon over a PR */ }
        try {
          const knowledge = new KnowledgeRuntimeService(this.db);
          const closure = knowledge.closeLoop({ loop_run_id: run.id });
          if (closure.status === 'blocked') {
            // Previously silently discarded — this is the one signal that
            // explains why loop_learning_closures stays near-empty even
            // when most runs pass their gates. Not fatal for the daemon.
            new LoopEventService(this.db).recordEvent(
              run.id,
              'learning_closure_blocked',
              'info',
              `Learning closure blocked: ${closure.blocked_reasons.join('; ') || 'no reason reported'}`,
              { blocked_reasons: closure.blocked_reasons },
            );
          }
        } catch (err) {
          // Best-effort: learning closure is not fatal for the daemon, but
          // record why it threw instead of discarding the error silently.
          try {
            new LoopEventService(this.db).recordEvent(
              run.id,
              'learning_closure_blocked',
              'warning',
              `Learning closure threw: ${err instanceof Error ? err.message : String(err)}`,
              {},
            );
          } catch { /* logging must never break the daemon */ }
        }
      }

      // 10. Update goal + run status.
      const goalStatus = allGatesPass ? 'completed' : 'failed';
      const runStatus = allGatesPass ? 'completed' : 'blocked';
      this.db.prepare('UPDATE goals SET status = ?, updated_at = ? WHERE id = ?')
        .run(goalStatus, new Date().toISOString(), goal.id);
      this.db.prepare('UPDATE loop_runs SET status = ?, updated_at = ? WHERE id = ?')
        .run(runStatus, new Date().toISOString(), run.id);

      swarmEventBus.emit('convergence', {
        daemon: 'goal_completed',
        goal_id: goal.id,
        run_id: run.id,
        certified: allGatesPass,
        gates: verification.gates.map(g => `${g.name}:${g.status}`),
        execution_mode: executionMode,
      });

    } catch (error) {
      if (runId && error instanceof Error && error.message === 'LOOP_WORKER_APPROVAL_REQUIRED' && this.blockForApproval(goal, runId)) return;
      // Mark the goal as failed if execution fails.
      this.db.prepare('UPDATE goals SET status = ?, updated_at = ? WHERE id = ?')
        .run('failed', new Date().toISOString(), goal.id);

      const failureMessage = error instanceof Error ? error.message : String(error);
      console.error(`[loop-daemon] goal ${goal.id} failed (run ${runId ?? 'none'}): ${failureMessage}`);
      if (runId) {
        try {
          new LoopEventService(this.db).recordEvent(runId, 'goal_failed', 'error', failureMessage, {
            goal_id: goal.id,
            execution_mode: executionMode,
          });
        } catch { /* best-effort: never mask the original failure */ }
      }
      try { new CommonsProposalReviewService(this.db).recordGoalOutcome(goal.id, 'failed', failureMessage); } catch { /* best-effort learning */ }
      if (runId) {
        swarmEventBus.emit('loop_completed', {
          loopRunId: runId, goalId: goal.id, goalType: loopName, mode: 'closed', status: 'failed',
          durationMs: Date.now() - startedAtMs, strategy: executionMode,
          startedAt: new Date(startedAtMs).toISOString(), completedAt: new Date().toISOString(),
        });
      }

      swarmEventBus.emit('convergence', {
        daemon: 'goal_failed',
        goal_id: goal.id,
        run_id: runId,
        error: error instanceof Error ? error.message : String(error),
        execution_mode: executionMode,
      });
    } finally {
      // G19: remove from active goals when done (success or failure).
      this.activeGoals.delete(goal.id);
      this.persistActiveGoals();
      this.pruneWorktrees();
    }
  }

  private pruneWorktrees(): void {
    try {
      this.loops.pruneOrphanedWorktrees();
    } catch (error) {
      console.error('[LoopDaemon] worktree cleanup error:', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * G19: Persist active goal IDs to system_state so they survive restarts.
   */
  private persistActiveGoals(): void {
    try {
      this.db.prepare('INSERT OR REPLACE INTO system_state (key, value, updated_at) VALUES (?, ?, ?)')
        .run('daemon_active_goals', JSON.stringify(Array.from(this.activeGoals)), new Date().toISOString());
    } catch { /* table might not exist — non-fatal */ }
  }

  /**
   * G19: Restore active goals from system_state on restart.
   * The goals themselves are recovered by G10 resumeInterruptedRuns; this just
   * restores the daemon's tracking set so it doesn't double-start them.
   */
  private restoreActiveGoals(): void {
    try {
      const row = this.db.prepare('SELECT value FROM system_state WHERE key = ?').get('daemon_active_goals') as { value?: string } | undefined;
      if (row?.value) {
        const ids = JSON.parse(row.value) as string[];
        // Check which goals are still active in the DB (not completed/failed).
        for (const id of ids) {
          const goal = this.db.prepare('SELECT status FROM goals WHERE id = ?').get(id) as { status: string } | undefined;
          if (goal && !['completed', 'failed', 'cancelled'].includes(goal.status)) {
            this.activeGoals.add(id);
          }
        }
      }
    } catch { /* non-fatal */ }
  }
}
