import type { Database } from 'better-sqlite3';
import { LoopService } from './loop-service';
import { swarmEventBus } from './swarm-event-bus';
import { GoalDecomposer } from './goal-decomposer';
import { ResourceScheduler } from './resource-scheduler';
import { SwarmIntelligenceService } from './swarm-intelligence-service';
import { KnowledgeRuntimeService } from './knowledge-runtime-service';
import { ReviewerIndependenceService } from './reviewer-independence-service';
import { authorityGateForGoal } from './authority-gate';
import { isCanonicalLoopName } from '@djimitflo/shared';

const AUTONOMOUS_RUNTIMES = ['codex', 'opencode', 'claude', 'gemini', 'editor', 'pi'] as const;
type AutonomousRuntime = typeof AUTONOMOUS_RUNTIMES[number];

function autonomousRuntime(value: unknown): AutonomousRuntime | undefined {
  return typeof value === 'string' && AUTONOMOUS_RUNTIMES.includes(value as AutonomousRuntime)
    ? value as AutonomousRuntime
    : undefined;
}

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
      const queue = this.loadQueue();
      if (queue.length === 0) {
        this.scheduleNext();
        return;
      }

      // G19: start as many goals as fit in the available slots.
      const slots = this.getAvailableSlots();
      const toStart = queue.slice(0, slots);

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

        // Mark goal as active + start it asynchronously.
        this.activeGoals.add(goal.id);
        this.persistActiveGoals();
        // Non-blocking: start the goal and don't wait for it to finish.
        this.executeGoal(goal).catch((err) => {
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
  private async executeGoal(goal: QueueEntry): Promise<void> {
    let runId: string | null = null;
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

      // 2. Start the loop (discovers findings, creates the loop_run).
      const recommendedLoop = typeof goal.metadata.recommended_loop === 'string'
        && isCanonicalLoopName(goal.metadata.recommended_loop)
        ? goal.metadata.recommended_loop
        : undefined;
      const repositoryPath = typeof goal.metadata.repository_path === 'string' && goal.metadata.repository_path.trim()
        ? goal.metadata.repository_path.trim()
        : process.env.LOOP_REPOSITORY_PATH?.trim();
      const makerRuntime = autonomousRuntime(goal.metadata.maker_runtime) || autonomousRuntime(process.env.LOOP_MAKER_RUNTIME);
      if (!makerRuntime) throw new Error('AUTONOMOUS_MAKER_RUNTIME_REQUIRED');
      const run = this.loops.startLoop({
        goal_id: goal.id,
        loop_name: recommendedLoop,
        ...(repositoryPath ? { repository_path: repositoryPath } : {}),
      });
      runId = run.id;

      // 3. Skip execution if no findings were discovered.
      if (run.findings.length === 0) {
        this.db.prepare(`UPDATE goals
          SET status = 'blocked',
              metadata = json_set(metadata, '$.completion_evidence_status', 'UNDETERMINED', '$.blocked_reason', 'no_findings'),
              updated_at = ?
          WHERE id = ?`).run(new Date().toISOString(), goal.id);
        swarmEventBus.emit('convergence', {
          daemon: 'goal_blocked',
          goal_id: goal.id,
          run_id: run.id,
          reason: 'no findings — acceptance evidence remains undetermined',
        });
        return;
      }

      swarmEventBus.emit('convergence', {
        daemon: 'goal_started',
        goal_id: goal.id,
        run_id: run.id,
        objective: goal.objective,
        active_goals: this.activeGoals.size,
      });

      // 4. Continue the loop — creates maker+checker leases (prepared status).
      // G28+G33: the planner selects the runtime per finding based on per-runtime
      // competence (not hardcoded 'codex'). The plan is produced inside continueLoopRun.
      const prepared = this.loops.continueLoopRun(run.id, {
        max_assignments: 1,
        max_maker_workers: 1,
        runtime: makerRuntime,
      });

      // 5. Find the prepared maker lease and execute it.
      const makerLease = prepared.leases.find(l => l.role === 'maker' && l.status === 'prepared');
      if (!makerLease) {
        throw new Error('No prepared maker lease found after continueLoopRun');
      }

      // 6. Execute the maker (runs the runtime — codex/opencode/pi).
      await this.loops.executeWorker(run.id, {
        lease_id: makerLease.id,
        timeout_ms: 300_000, // 5 min timeout for production goals
        diff_max_lines: 200,
        skip_permissions: Boolean(process.env.RUNTIME_ALLOW_SKIP_PERMISSIONS),
      });

      // 7. Run deterministic checks (test, lint, type-check) and retry once.
      let activeMaker = makerLease;
      let checks = this.loops.runDeterministicChecks(run.id, {
        lease_id: activeMaker.id,
        timeout_ms: 120_000,
      });
      if (checks.run.status === 'blocked') {
        const retry = this.loops.retryLoopRun(run.id, { maker_lease_id: activeMaker.id });
        activeMaker = retry.retry_maker;
        await this.loops.executeWorker(run.id, {
          lease_id: activeMaker.id,
          timeout_ms: 300_000,
          diff_max_lines: 200,
          skip_permissions: Boolean(process.env.RUNTIME_ALLOW_SKIP_PERMISSIONS),
        });
        checks = this.loops.runDeterministicChecks(run.id, {
          lease_id: activeMaker.id,
          timeout_ms: 120_000,
        });
      }
      if (checks.run.status === 'blocked') throw new Error('DETERMINISTIC_CHECKS_FAILED');

      // 8. Select and execute a distinct real checker runtime.
      const checkerRuntime = autonomousRuntime(goal.metadata.checker_runtime) || autonomousRuntime(process.env.LOOP_CHECKER_RUNTIME);
      if (!checkerRuntime) throw new Error('INDEPENDENT_CHECKER_RUNTIME_REQUIRED');
      if (checkerRuntime === activeMaker.runtime) throw new Error('CHECKER_RUNTIME_NOT_INDEPENDENT');
      const checkerLease = this.loops.listWorkerLeases(run.id).find((lease) =>
        lease.role === 'checker'
        && lease.status === 'prepared'
        && lease.metadata.maker_lease_id === activeMaker.id
      );
      if (!checkerLease) throw new Error('CHECKER_LEASE_NOT_FOUND');
      await this.loops.executeChecker(run.id, {
        lease_id: checkerLease.id,
        runtime: checkerRuntime,
        timeout_ms: 300_000,
        skip_permissions: Boolean(process.env.RUNTIME_ALLOW_SKIP_PERMISSIONS),
      });

      // 9. Require independently evidenced review, then reuse canonical certification.
      const independence = new ReviewerIndependenceService(this.db).assessLoop(run.id);
      if (independence.state !== 'PASS') throw new Error(`CHECKER_INDEPENDENCE_${independence.state}`);
      const certification = this.loops.certifyLoopRun(run.id);
      const learning = certification.certified
        ? new KnowledgeRuntimeService(this.db).closeLoop({ loop_run_id: run.id })
        : null;
      const candidateReady = certification.certified && learning?.status === 'closed';

      // 10. Keep a certified candidate behind the existing human promotion boundary.
      this.loops.updateGoal(goal.id, {
        status: candidateReady ? 'blocked' : 'failed',
        metadata: {
          ...goal.metadata,
          loop_run_id: run.id,
          completion_evidence_status: candidateReady ? 'SUPPORTED' : 'UNDETERMINED',
          blocked_reason: candidateReady ? 'human_approval_required' : 'learning_closure_blocked',
          reviewer_independence: independence,
          learning_closure_status: learning?.status || 'not_started',
          promotion_performed: false,
        },
      });

      swarmEventBus.emit('convergence', {
        daemon: candidateReady ? 'goal_candidate_ready' : 'goal_blocked',
        goal_id: goal.id,
        run_id: run.id,
        certified: certification.certified,
        learning_closed: learning?.status === 'closed',
        promotion_performed: false,
        gates: certification.gates.map(g => `${g.name}:${g.status}`),
      });

    } catch (error) {
      const now = new Date().toISOString();
      const errorMessage = error instanceof Error ? error.message : String(error);
      const failureCode = errorMessage.match(/^[A-Z][A-Z0-9_]+/)?.[0]
        || (error instanceof Error ? error.name : 'UNKNOWN_EXECUTION_FAILURE');
      this.db.prepare(`UPDATE goals
        SET status = 'failed',
            metadata = json_set(metadata, '$.completion_evidence_status', 'UNDETERMINED', '$.blocked_reason', 'execution_failed', '$.execution_failure', ?),
            updated_at = ?
        WHERE id = ?`).run(failureCode, now, goal.id);
      if (runId) {
        this.db.prepare(`UPDATE loop_runs
          SET status = 'blocked',
              metadata = json_set(metadata, '$.completion_evidence_status', 'UNDETERMINED', '$.blocked_reason', 'execution_failed', '$.execution_failure', ?),
              updated_at = ?
          WHERE id = ?`).run(failureCode, now, runId);
      }

      swarmEventBus.emit('convergence', {
        daemon: 'goal_failed',
        goal_id: goal.id,
        run_id: runId,
        error: errorMessage,
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
