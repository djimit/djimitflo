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

    // authorityGateForGoal's own schema (see authority-gate.ts) — not created
    // by schema.ts/migrate.ts, so a fresh test DB genuinely lacks it (matching
    // production behavior: fail-closed under AUTHORITY_GATE=enforce until an
    // operator has actually approved a goal).
    db.exec(`
      CREATE TABLE authority_events (
        id TEXT PRIMARY KEY, event_id TEXT, correlation_id TEXT, sequence INTEGER,
        occurred_at TEXT, actor_subject TEXT, actor_type TEXT, actor_issuer TEXT,
        artifact_id TEXT, requested_state TEXT, policy_decision TEXT,
        payload_digest TEXT, payload_json TEXT, evidence_refs_json TEXT, source_system TEXT
      );
    `);

    let runCounter = 0;
    stubLoops = {
      startObjectiveLoop: vi.fn(() => ({ id: `objective-run-${++runCounter}`, findings: [] })),
      startDocDriftAndSmallFixLoop: vi.fn(() => ({ id: `docdrift-run-${++runCounter}`, findings: [] })),
      pruneOrphanedWorktrees: vi.fn(),
    };

    for (const key of ['SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED', 'SELF_IMPROVEMENT_OBJECTIVE_LOOP_MAX_PER_TICK', 'AUTHORITY_GATE']) {
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

  function allowViaAuthorityGate(goalId: string) {
    db.prepare(`
      INSERT INTO authority_events
        (id, event_id, correlation_id, sequence, occurred_at, actor_subject, actor_type, actor_issuer, artifact_id, requested_state, policy_decision, payload_digest, payload_json, evidence_refs_json, source_system)
      VALUES (?, ?, ?, 1, datetime('now'), 'test-operator', 'human', 'local', ?, 'PLAN_APPROVED', 'ALLOW', 'sha256:test', '{}', '[]', 'test')
    `).run(`allow-${goalId}`, `allow-${goalId}`, goalId, goalId);
  }

  async function runOneTick(daemon: LoopDaemon) {
    await daemon.tick();
    daemon.stop(); // tick() reschedules itself via setTimeout; stop() clears it so the test doesn't leak timers
  }

  it('stays on startDocDriftAndSmallFixLoop by default, even for an otherwise-qualifying goal (inert until armed)', async () => {
    const goal = seedQualifyingGoal();
    allowViaAuthorityGate(goal.id);
    process.env.AUTHORITY_GATE = 'enforce';
    const daemon = new LoopDaemon(db, stubLoops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
    await runOneTick(daemon);
    expect(stubLoops.startObjectiveLoop).not.toHaveBeenCalled();
    expect(stubLoops.startDocDriftAndSmallFixLoop).toHaveBeenCalledWith({ goal_id: goal.id });
  });

  it('dispatches to startObjectiveLoop when the flag is on, the goal qualifies, and the authority gate allows it', async () => {
    const goal = seedQualifyingGoal();
    allowViaAuthorityGate(goal.id);
    process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED = 'true';
    process.env.AUTHORITY_GATE = 'enforce';
    const daemon = new LoopDaemon(db, stubLoops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
    await runOneTick(daemon);
    expect(stubLoops.startObjectiveLoop).toHaveBeenCalledWith({ goal_id: goal.id });
    expect(stubLoops.startDocDriftAndSmallFixLoop).not.toHaveBeenCalled();
  });

  it('does not dispatch to startObjectiveLoop when the flag is on but AUTHORITY_GATE is not enforced', async () => {
    const goal = seedQualifyingGoal();
    allowViaAuthorityGate(goal.id);
    process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED = 'true';
    // AUTHORITY_GATE left unset ('off') — belt-and-suspenders condition not met.
    const daemon = new LoopDaemon(db, stubLoops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
    await runOneTick(daemon);
    expect(stubLoops.startObjectiveLoop).not.toHaveBeenCalled();
    expect(stubLoops.startDocDriftAndSmallFixLoop).toHaveBeenCalled();
  });

  it('does not dispatch a non-self-improvement-sourced goal to startObjectiveLoop even when the flag is on', async () => {
    const goal = seedQualifyingGoal({ source: 'security-scan' });
    allowViaAuthorityGate(goal.id);
    process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED = 'true';
    process.env.AUTHORITY_GATE = 'enforce';
    const daemon = new LoopDaemon(db, stubLoops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
    await runOneTick(daemon);
    expect(stubLoops.startObjectiveLoop).not.toHaveBeenCalled();
    expect(stubLoops.startDocDriftAndSmallFixLoop).toHaveBeenCalled();
  });

  it('does not dispatch a non-low-risk self-improvement goal to startObjectiveLoop even when the flag is on', async () => {
    const goal = seedQualifyingGoal({ risk_class: 'high' });
    allowViaAuthorityGate(goal.id);
    process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED = 'true';
    process.env.AUTHORITY_GATE = 'enforce';
    const daemon = new LoopDaemon(db, stubLoops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
    await runOneTick(daemon);
    expect(stubLoops.startObjectiveLoop).not.toHaveBeenCalled();
    expect(stubLoops.startDocDriftAndSmallFixLoop).toHaveBeenCalled();
  });

  it('enforces the per-tick cap across a batch of qualifying goals', async () => {
    const goalA = seedQualifyingGoal();
    const goalB = seedQualifyingGoal();
    allowViaAuthorityGate(goalA.id);
    allowViaAuthorityGate(goalB.id);
    process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED = 'true';
    process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_MAX_PER_TICK = '1';
    process.env.AUTHORITY_GATE = 'enforce';

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
    allowViaAuthorityGate(goal.id);
    process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED = 'true';
    process.env.AUTHORITY_GATE = 'enforce';

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
