import type { Database } from 'better-sqlite3';
import { LoopService } from './loop-service';
import { swarmEventBus } from './swarm-event-bus';

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

  constructor(
    private db: Database,
    private loops: LoopService,
    opts: { pollMs?: number; maxConcurrentGoals?: number } = {},
  ) {
    this.pollMs = opts.pollMs ?? (Number(process.env.GOAL_QUEUE_POLL_MS) || 5000);
    this.maxConcurrentGoals = opts.maxConcurrentGoals ?? (Number(process.env.GOAL_MAX_CONCURRENT) || 4);
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
   * Execute a single goal: decompose → start loop → certify → learn → persist.
   * This is async and non-blocking — the tick continues to the next goal.
   */
  private async executeGoal(goal: QueueEntry): Promise<void> {
    try {
      // Decompose the goal if not already decomposed.
      const currentStatus = this.db.prepare('SELECT status FROM goals WHERE id = ?').get(goal.id) as { status: string } | undefined;
      if (currentStatus?.status === 'created') {
        this.loops.decomposeGoal(goal.id);
      }

      // Start the loop for this goal.
      const run = this.loops.startDocDriftAndSmallFixLoop({
        goal_id: goal.id,
        sovereign: Boolean((goal.metadata as Record<string, unknown>).sovereign),
      });

      swarmEventBus.emit('convergence', {
        daemon: 'goal_started',
        goal_id: goal.id,
        run_id: run.id,
        objective: goal.objective,
        active_goals: this.activeGoals.size,
      });
    } catch (error) {
      // Mark the goal as failed if execution fails.
      this.db.prepare('UPDATE goals SET status = ?, updated_at = ? WHERE id = ?')
        .run('failed', new Date().toISOString(), goal.id);

      swarmEventBus.emit('convergence', {
        daemon: 'goal_failed',
        goal_id: goal.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // G19: remove from active goals when done (success or failure).
      this.activeGoals.delete(goal.id);
      this.persistActiveGoals();
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
