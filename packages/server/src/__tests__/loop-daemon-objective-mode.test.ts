import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopDaemon } from '../services/loop-daemon';
import { GoalService } from '../services/goal-service';
import { swarmEventBus } from '../services/swarm-event-bus';
import type { LoopService } from '../services/loop-service';

/**
 * Dispatch-branching coverage for the fix to the production bug found
 * 2026-09-20: LoopDaemon.executeGoal() unconditionally dispatched every
 * self-improvement goal to startDocDriftAndSmallFixLoop() (a fixed scanner
 * that never looks at the goal's objective), so 10/10 executed goals
 * produced the byte-identical canned "no findings" result.
 *
 * Uses a stubbed LoopService-shaped dependency (findings: [] on both start
 * methods, so executeGoal takes its early "no findings" return and never
 * needs continueLoopRun/executeWorker/runDeterministicChecks/verifyLoopRun)
 * — this tests dispatch branching only. The real maker/checker path through
 * a genuine objective-mode finding is covered separately in
 * loop-service-objective-finding.test.ts.
 *
 * Note: an earlier revision also required AUTHORITY_GATE=enforce as a
 * belt-and-suspenders condition. Dropped after finding that flag isn't
 * scoped to this feature — authorityGateForGoal() runs for every goal the
 * daemon processes and fail-closes ALL goal execution when the
 * authority_events table is missing (true in every environment checked),
 * so enforcing it would have halted the whole daemon, not just gated this
 * feature. AUTHORITY_GATE is left unset (default 'off') throughout this
 * file — the standard authority gate always allows in that mode, which is
 * exactly what lets these tests isolate objective-mode's own gating logic.
 */
describe('LoopDaemon objective-mode dispatch', () => {
  let db: Database.Database;
  let goals: GoalService;
  let stubLoops: { startObjectiveLoop: ReturnType<typeof vi.fn>; startDocDriftAndSmallFixLoop: ReturnType<typeof vi.fn>; pruneOrphanedWorktrees: ReturnType<typeof vi.fn> };
  const prevEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    goals = new GoalService(db);

    let runCounter = 0;
    stubLoops = {
      startObjectiveLoop: vi.fn(() => ({ id: `objective-run-${++runCounter}`, findings: [] })),
      startDocDriftAndSmallFixLoop: vi.fn(() => ({ id: `docdrift-run-${++runCounter}`, findings: [] })),
      pruneOrphanedWorktrees: vi.fn(),
    };

    for (const key of ['SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED', 'SELF_IMPROVEMENT_OBJECTIVE_LOOP_MAX_PER_TICK', 'AUTHORITY_GATE', 'LOOP_DAEMON_REPOSITORY_PATH', 'LOOP_DAEMON_MAKER_RUNTIME']) {
      prevEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    db?.close();
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function seedQualifyingGoal(overrides: { risk_class?: 'low' | 'medium' | 'high' | 'critical'; source?: string } = {}) {
    const goal = goals.createGoal({
      objective: 'Implement the missing retry backoff',
      acceptance_criteria: ['Tests pass'],
      risk_class: overrides.risk_class ?? 'low',
      metadata: { source: overrides.source ?? 'self-improvement' },
    });
    db.prepare("UPDATE goals SET status = 'decomposed' WHERE id = ?").run(goal.id);
    return goal;
  }

  async function runOneTick(daemon: LoopDaemon) {
    await daemon.tick();
    daemon.stop(); // tick() reschedules itself via setTimeout; stop() clears it so the test doesn't leak timers
  }

  it('stays on startDocDriftAndSmallFixLoop by default, even for an otherwise-qualifying goal (inert until armed)', async () => {
    const goal = seedQualifyingGoal();
    const daemon = new LoopDaemon(db, stubLoops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
    await runOneTick(daemon);
    expect(stubLoops.startObjectiveLoop).not.toHaveBeenCalled();
    expect(stubLoops.startDocDriftAndSmallFixLoop).toHaveBeenCalledWith({ goal_id: goal.id });
  });

  it('dispatches to startObjectiveLoop when the flag is on and the goal qualifies', async () => {
    const goal = seedQualifyingGoal();
    process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED = 'true';
    const daemon = new LoopDaemon(db, stubLoops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
    await runOneTick(daemon);
    expect(stubLoops.startObjectiveLoop).toHaveBeenCalledWith({ goal_id: goal.id });
    expect(stubLoops.startDocDriftAndSmallFixLoop).not.toHaveBeenCalled();
  });

  it('passes LOOP_DAEMON_REPOSITORY_PATH to objective mode only (doc-drift keeps its default)', async () => {
    const goal = seedQualifyingGoal();
    process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED = 'true';
    process.env.LOOP_DAEMON_REPOSITORY_PATH = '/workspace/djimitflo';
    const daemon = new LoopDaemon(db, stubLoops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
    await runOneTick(daemon);
    expect(stubLoops.startObjectiveLoop).toHaveBeenCalledWith({ goal_id: goal.id, repository_path: '/workspace/djimitflo' });
    expect(stubLoops.startDocDriftAndSmallFixLoop).not.toHaveBeenCalled();
  });

  it('passes the operator-configured maker runtime to continueLoopRun for objective mode only', async () => {
    seedQualifyingGoal();
    process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED = 'true';
    process.env.LOOP_DAEMON_MAKER_RUNTIME = 'opencode';
    const continueLoopRun = vi.fn(() => { throw new Error('stop-after-capture'); });
    const loops = { ...stubLoops, startObjectiveLoop: vi.fn(() => ({ id: 'objective-run-x', findings: [{ id: 'f1' }] })), continueLoopRun };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const daemon = new LoopDaemon(db, loops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
    await runOneTick(daemon);
    expect(continueLoopRun).toHaveBeenCalledWith('objective-run-x', { max_assignments: 1, max_maker_workers: 1, runtime: 'opencode' });
  });

  it('does not dispatch a non-self-improvement-sourced goal to startObjectiveLoop even when the flag is on', async () => {
    const goal = seedQualifyingGoal({ source: 'security-scan' });
    process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED = 'true';
    const daemon = new LoopDaemon(db, stubLoops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
    await runOneTick(daemon);
    expect(stubLoops.startObjectiveLoop).not.toHaveBeenCalled();
    expect(stubLoops.startDocDriftAndSmallFixLoop).toHaveBeenCalled();
  });

  it('does not dispatch a non-low-risk self-improvement goal to startObjectiveLoop even when the flag is on', async () => {
    const goal = seedQualifyingGoal({ risk_class: 'high' });
    process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED = 'true';
    const daemon = new LoopDaemon(db, stubLoops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
    await runOneTick(daemon);
    expect(stubLoops.startObjectiveLoop).not.toHaveBeenCalled();
    expect(stubLoops.startDocDriftAndSmallFixLoop).toHaveBeenCalled();
  });

  it('enforces the per-tick cap across a batch of qualifying goals', async () => {
    seedQualifyingGoal();
    seedQualifyingGoal();
    process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED = 'true';
    process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_MAX_PER_TICK = '1';

    const decisions: Record<string, unknown>[] = [];
    const unsubscribe = swarmEventBus.subscribe((event) => {
      if (event.type === 'convergence') decisions.push(event.data);
    });
    try {
      const daemon = new LoopDaemon(db, stubLoops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
      await runOneTick(daemon);
      expect(stubLoops.startObjectiveLoop).toHaveBeenCalledTimes(1);
      expect(stubLoops.startDocDriftAndSmallFixLoop).toHaveBeenCalledTimes(1);
      const cappedDecision = decisions.find(
        (d) => d.daemon === 'objective_mode_decision' && d.reason === 'per_tick_cap_reached',
      );
      expect(cappedDecision).toBeTruthy();
    } finally {
      unsubscribe();
    }
  });

  it('tags terminal goal_completed events with the execution_mode that actually ran', async () => {
    const goal = seedQualifyingGoal();
    process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED = 'true';

    const completedEvents: Record<string, unknown>[] = [];
    const unsubscribe = swarmEventBus.subscribe((event) => {
      if (event.type === 'convergence' && event.data.daemon === 'goal_completed') completedEvents.push(event.data);
    });
    try {
      const daemon = new LoopDaemon(db, stubLoops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
      await runOneTick(daemon);
      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]).toMatchObject({ goal_id: goal.id, execution_mode: 'objective' });
    } finally {
      unsubscribe();
    }
  });
});
