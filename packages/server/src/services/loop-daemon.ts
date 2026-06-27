import type { Database } from 'better-sqlite3';
import { LoopService } from './loop-service';
import { swarmEventBus } from './swarm-event-bus';

/**
 * G16: LoopDaemon — continuous operation mode.
 *
 * Wraps LoopService to run an always-on goal queue. On start, loads pending goals
 * from the `goals` table (status = 'pending' | 'decomposed'), sorts by
 * (risk_class desc, value desc, estimated_cost asc), and executes them in a loop
 * (decompose → execute → certify → learn → persist).
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

  constructor(
    private db: Database,
    private loops: LoopService,
    opts: { pollMs?: number } = {},
  ) {
    this.pollMs = opts.pollMs ?? (Number(process.env.GOAL_QUEUE_POLL_MS) || 5000);
  }

  /**
   * Start the daemon — polls the goal queue at pollMs intervals.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    swarmEventBus.emit('recovery', { daemon: 'started', poll_ms: this.pollMs });
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
   * Process one tick: load pending goals, sort by priority, execute the top goal.
   */
  async tick(): Promise<void> {
    // Allow tick to run even when not started (for testing)

    try {
      const queue = this.loadQueue();
      if (queue.length === 0) {
        // No goals — wait and tick again.
        this.scheduleNext();
        return;
      }

      const goal = queue[0]; // highest priority
      await this.executeGoal(goal);
    } catch (error) {
      // Non-fatal — the daemon continues.
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
   * Execute a single goal: decompose → start loop → (the loop runs via continueLoopRun).
   * In this implementation, the daemon decomposes the goal and starts the loop.
   * The actual maker/checker execution happens via the existing continueLoopRun API
   * (called by the operator or a future automated continuation).
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
    }
  }
}
