import type { Database } from 'better-sqlite3';
import { LoopService } from './loop-service';
import { swarmEventBus } from './swarm-event-bus';
import { GoalDecomposer } from './goal-decomposer';
import { ResourceScheduler } from './resource-scheduler';
import { SwarmIntelligenceService } from './swarm-intelligence-service';
import { KnowledgeRuntimeService } from './knowledge-runtime-service';
import { LoopEventService } from './loop-event-service';
import { CommonsProposalReviewService } from './commons-proposal-review-service';
import { SelfImprovementService } from './self-improvement-service';
import { authorityGateForGoal } from './authority-gate';
/** Deterministic checks for daemon runs. The repo-wide `test` script cannot finish in 120 s, so hosts can scope it
 *  (LOOP_DAEMON_CHECK_SCRIPTS=test:changed,lint,type-check) and raise the per-script timeout (LOOP_DAEMON_CHECK_TIMEOUT_MS, max 600000). */
export function daemonCheckOptions(env: NodeJS.ProcessEnv = process.env): { scripts?: string[]; timeout_ms: number } {
  const scripts = (env.LOOP_DAEMON_CHECK_SCRIPTS || '').split(',').map((v) => v.trim()).filter(Boolean);
  const timeout = Number(env.LOOP_DAEMON_CHECK_TIMEOUT_MS);
  return { ...(scripts.length ? { scripts } : {}), timeout_ms: Number.isFinite(timeout) && timeout >= 1000 ? Math.min(timeout, 600_000) : 120_000 };
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
      const toStart = queue.slice(0, slots);
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
        this.executeGoal(goal, { allowObjectiveMode }).catch((err) => {
          console.error('[LoopDaemon] goal execution error:', err instanceof Error ? err.message : String(err));
        });
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
    console.warn(`[loop-daemon] goal ${goal.id} waits for approval ${approvalId} (run ${runId})`);
    swarmEventBus.emit('convergence', { daemon: 'goal_awaiting_approval', goal_id: goal.id, run_id: runId, approval_id: approvalId });
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
      const makerAlreadyDone = resumeRunId ? prepared.leases.find(l => l.role === 'maker' && l.status === 'completed') : undefined;
      const makerLease = makerAlreadyDone ?? prepared.leases.find(l => l.role === 'maker' && l.status === 'prepared');
      if (!makerLease) {
        throw new Error('No prepared maker lease found after continueLoopRun');
      }

      // 6. Execute the maker (runs the runtime — codex/opencode/pi).
      if (!makerAlreadyDone) await this.loops.executeWorker(run.id, {
        lease_id: makerLease.id,
        timeout_ms: 300_000, // 5 min timeout for production goals
        diff_max_lines: 200,
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
            await this.loops.executeWorker(run.id, {
              lease_id: retryMaker.id,
              timeout_ms: 300_000,
              diff_max_lines: 200,
              skip_permissions: Boolean(process.env.RUNTIME_ALLOW_SKIP_PERMISSIONS),
            });
            this.loops.runDeterministicChecks(run.id, {
              lease_id: retryMaker.id,
              ...daemonCheckOptions(),
            });
            activeMakerLease = retryMaker;
          } catch { /* best-effort retry */ }
        }
      } catch { /* best-effort: checks are not fatal for the daemon */ }

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
            await this.loops.executeChecker(run.id, { ...(leaseId ? { lease_id: leaseId } : {}), runtime, timeout_ms: 120_000 });
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
        if (linked?.improvement_id) new SelfImprovementService(this.db).recordOutcome(linked.improvement_id, allGatesPass ? 'verified' : 'regressed');
      } catch { /* best-effort learning */ }

      // 9b. Close learning loop (reflection + memory + follow-up).
      if (allGatesPass) {
        try { new CommonsProposalReviewService(this.db).recordGoalOutcome(goal.id, 'completed', `run ${run.id} certified`); } catch { /* best-effort learning */ }
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
