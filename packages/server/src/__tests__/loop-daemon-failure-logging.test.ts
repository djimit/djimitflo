import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopDaemon } from '../services/loop-daemon';
import { GoalService } from '../services/goal-service';
import type { LoopService } from '../services/loop-service';

/**
 * Regression: a failed executeGoal() used to emit only to swarmEventBus, so the
 * first real objective-mode failure (2026-09-20) left no trace of its reason.
 */
describe('LoopDaemon failure logging', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
  });

  afterEach(() => { db?.close(); vi.restoreAllMocks(); });

  it('persists the failure reason to loop_events and console.error, and marks the goal failed', async () => {
    const goal = new GoalService(db).createGoal({
      objective: 'Implement the missing retry backoff',
      acceptance_criteria: ['Tests pass'],
      risk_class: 'low',
      metadata: { source: 'self-improvement' },
    });
    db.prepare("UPDATE goals SET status = 'decomposed' WHERE id = ?").run(goal.id);

    // Stub creates a real loop_run, returns a finding, then continueLoopRun blows up.
    const stubLoops = {
      pruneOrphanedWorktrees: vi.fn(),
      startDocDriftAndSmallFixLoop: vi.fn(() => {
        db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status) VALUES ('run-1', ?, 'doc-drift', 'closed', 'planning')").run(goal.id);
        return { id: 'run-1', findings: [{ id: 'f1' }] };
      }),
      continueLoopRun: vi.fn(() => { throw new Error('boom: planning exploded'); }),
    };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const daemon = new LoopDaemon(db, stubLoops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
    await daemon.tick();
    daemon.stop();

    const row = db.prepare("SELECT level, message FROM loop_events WHERE loop_run_id = 'run-1' AND event_type = 'goal_failed'").get() as { level: string; message: string } | undefined;
    expect(row?.level).toBe('error');
    expect(row?.message).toContain('boom: planning exploded');
    expect(errSpy.mock.calls.some(c => String(c[0]).includes('boom: planning exploded'))).toBe(true);
    expect((db.prepare('SELECT status FROM goals WHERE id = ?').get(goal.id) as { status: string }).status).toBe('failed');
  });
});
