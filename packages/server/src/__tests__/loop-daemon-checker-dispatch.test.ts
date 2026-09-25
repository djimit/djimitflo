import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopDaemon } from '../services/loop-daemon';
import { GoalService } from '../services/goal-service';
import { LoopService } from '../services/loop-service';

/**
 * Regression coverage for the fix to the root cause found 2026-09-20/21:
 * LoopDaemon.executeGoal() created a checker lease (via continueLoopRun)
 * but never dispatched it, so verifyLoopRun()'s checker_verdict gate could
 * never pass and closeLoop() (gated on allGatesPass) was never reached —
 * the real reason loop_learning_closures stayed near-empty despite most
 * runs completing their maker side and passing deterministic checks.
 *
 * Checker leases are always created with runtime:'manual' regardless of
 * the maker's runtime — by design, code review requires a human today.
 * Automating checker dispatch is therefore a real autonomy expansion, not
 * just a missing call, so it's gated behind LOOP_DAEMON_AUTOMATED_CHECKER_ENABLED
 * (default off) and — when armed — reuses whichever maker lease actually
 * ran (original or retry) and its runtime, confirmed with the user rather
 * than assumed.
 *
 * Uses a stubbed LoopService-shaped dependency to test dispatch ordering
 * only — the real checker execution mechanics (evidence writes, gate
 * outcomes) are covered separately in loop-service-checker-dispatch.test.ts.
 */
describe('LoopDaemon checker dispatch', () => {
  let db: Database.Database;
  let goals: GoalService;
  let stubLoops: {
    startDocDriftAndSmallFixLoop: ReturnType<typeof vi.fn>;
    continueLoopRun: ReturnType<typeof vi.fn>;
    executeWorker: ReturnType<typeof vi.fn>;
    runDeterministicChecks: ReturnType<typeof vi.fn>;
    retryLoopRun: ReturnType<typeof vi.fn>;
    executeChecker: ReturnType<typeof vi.fn>;
    verifyLoopRun: ReturnType<typeof vi.fn>;
    pruneOrphanedWorktrees: ReturnType<typeof vi.fn>;
  };
  const prevEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    goals = new GoalService(db);

    stubLoops = {
      startDocDriftAndSmallFixLoop: vi.fn(() => ({
        id: 'run-1',
        findings: [{ id: 'finding-1', type: 'test_finding', severity: 'info', file: 'x', message: 'x', evidence: 'x', suggested_fix: 'x' }],
      })),
      continueLoopRun: vi.fn(() => ({
        leases: [
          { id: 'maker-1', role: 'maker', status: 'prepared', runtime: 'codex' },
          { id: 'checker-1', role: 'checker', status: 'prepared', runtime: 'manual' },
        ],
      })),
      executeWorker: vi.fn(async () => ({})),
      runDeterministicChecks: vi.fn(() => ({ run: { status: 'completed' }, lease: {}, checks: [] })),
      retryLoopRun: vi.fn(() => ({
        retry_maker: { id: 'maker-2', role: 'maker', status: 'prepared', runtime: 'opencode' },
        retry_checker: { id: 'checker-2', role: 'checker', status: 'prepared', runtime: 'manual' },
      })),
      executeChecker: vi.fn(async () => ({})),
      verifyLoopRun: vi.fn(() => ({ gates: [] })), // allGatesPass=false — keeps this file focused on dispatch, not closeLoop
      pruneOrphanedWorktrees: vi.fn(),
    };

    for (const key of ['LOOP_DAEMON_AUTOMATED_CHECKER_ENABLED']) {
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

  function seedQualifyingGoal() {
    const goal = goals.createGoal({
      objective: 'Fix a small doc drift issue',
      acceptance_criteria: ['Tests pass'],
      risk_class: 'low',
      metadata: {},
    });
    db.prepare("UPDATE goals SET status = 'decomposed' WHERE id = ?").run(goal.id);
    return goal;
  }

  async function runOneTick(daemon: LoopDaemon) {
    await daemon.tick();
    await new Promise((resolve) => setImmediate(resolve)); // executeGoal is fire-and-forget: let it finish
    daemon.stop();
  }

  it('never dispatches the checker by default (safe: preserves human review)', async () => {
    seedQualifyingGoal();
    const daemon = new LoopDaemon(db, stubLoops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
    await runOneTick(daemon);
    expect(stubLoops.executeChecker).not.toHaveBeenCalled();
  });

  it('dispatches the checker using the maker\'s runtime once armed, with no retry', async () => {
    seedQualifyingGoal();
    process.env.LOOP_DAEMON_AUTOMATED_CHECKER_ENABLED = 'true';
    const daemon = new LoopDaemon(db, stubLoops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
    await runOneTick(daemon);
    expect(stubLoops.executeChecker).toHaveBeenCalledWith('run-1', { runtime: 'codex', timeout_ms: 300_000 });
    expect(stubLoops.retryLoopRun).not.toHaveBeenCalled();
  });

  it('uses the retry maker\'s runtime for the checker, not the original, when a retry occurred', async () => {
    seedQualifyingGoal();
    process.env.LOOP_DAEMON_AUTOMATED_CHECKER_ENABLED = 'true';
    stubLoops.runDeterministicChecks.mockReturnValueOnce({ run: { status: 'blocked' }, lease: {}, checks: [] });
    const daemon = new LoopDaemon(db, stubLoops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
    await runOneTick(daemon);
    expect(stubLoops.retryLoopRun).toHaveBeenCalled();
    expect(stubLoops.executeChecker).toHaveBeenCalledWith('run-1', { runtime: 'opencode', timeout_ms: 300_000 });
  });

  it('does not crash the daemon when the checker throws (best-effort)', async () => {
    seedQualifyingGoal();
    process.env.LOOP_DAEMON_AUTOMATED_CHECKER_ENABLED = 'true';
    stubLoops.executeChecker.mockRejectedValueOnce(new Error('some runtime failure'));
    const daemon = new LoopDaemon(db, stubLoops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
    await expect(runOneTick(daemon)).resolves.not.toThrow();
    expect(stubLoops.verifyLoopRun).toHaveBeenCalled();
  });

  it('calls executeChecker before verifyLoopRun, so the checker_verdict gate reflects the real attempt', async () => {
    seedQualifyingGoal();
    process.env.LOOP_DAEMON_AUTOMATED_CHECKER_ENABLED = 'true';
    const callOrder: string[] = [];
    stubLoops.executeChecker.mockImplementation(async () => { callOrder.push('executeChecker'); return {}; });
    stubLoops.verifyLoopRun.mockImplementation(() => { callOrder.push('verifyLoopRun'); return { gates: [] }; });
    const daemon = new LoopDaemon(db, stubLoops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
    await runOneTick(daemon);
    expect(callOrder).toEqual(['executeChecker', 'verifyLoopRun']);
  });

  it('records one skill outcome per run for its maker skill (loop × runtime), E10', async () => {
    seedQualifyingGoal();
    const daemon = new LoopDaemon(db, stubLoops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
    await runOneTick(daemon);
    const rows = db.prepare('SELECT skill_id, success, task_id, agent_id, domain FROM skill_outcomes').all();
    expect(rows).toEqual([{ skill_id: 'loop-maker:doc-drift-and-small-fix-loop:codex', success: 0, task_id: 'run-1', agent_id: 'maker-1', domain: 'doc-drift-and-small-fix-loop' }]);
  });

  it('evolve (E13): with LOOP_EVOLVE_ENABLED an eligible goal gets a sibling maker per species before the checker', async () => {
    const goal = seedQualifyingGoal();
    db.prepare("UPDATE goals SET metadata = '{\"evolve\":true}' WHERE id = ?").run(goal.id);
    process.env.LOOP_EVOLVE_ENABLED = 'true'; process.env.LOOP_EVOLVE_SPECIES = 'opencode@ollama/kimi-k2.6:cloud';
    try {
      const daemon = new LoopDaemon(db, stubLoops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
      await runOneTick(daemon);
      expect(stubLoops.retryLoopRun).toHaveBeenCalledWith('run-1', { maker_lease_id: 'maker-1', sibling: true, runtime: 'opencode', model: 'ollama/kimi-k2.6:cloud' });
      expect(stubLoops.executeWorker).toHaveBeenCalledTimes(2);
      expect(stubLoops.runDeterministicChecks).toHaveBeenCalledWith('run-1', expect.objectContaining({ lease_id: 'maker-2' }));
    } finally { delete process.env.LOOP_EVOLVE_ENABLED; delete process.env.LOOP_EVOLVE_SPECIES; }
  });

  it('N6: an evolve sibling asking for approval inherits the auto-approved scope of the first maker; elsewhere it still fails', async () => {
    const goal = seedQualifyingGoal();
    db.prepare("UPDATE goals SET metadata = '{\"evolve\":true}' WHERE id = ?").run(goal.id);
    db.pragma('foreign_keys = OFF');
    const scope = 'packages/server/src/__tests__/x.test.ts';
    db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES ('maker-1', 'run-1', 'maker', 'codex', 'completed', ?)").run(JSON.stringify({ auto_approved_scope: scope }));
    db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES ('maker-2', 'run-1', 'maker', 'opencode', 'prepared', '{\"approval_id\":\"appr-sib\"}')").run();
    let siblingCalls = 0;
    stubLoops.executeWorker.mockImplementation(async (_run: string, input: { lease_id: string }) => {
      if (input.lease_id === 'maker-2' && siblingCalls++ === 0) throw new Error('LOOP_WORKER_APPROVAL_REQUIRED');
      return {};
    });
    const decide = vi.fn(async () => null);
    (stubLoops as unknown as { decideWorkerApproval: typeof decide; awaitWorkerExecution: () => Promise<null> }).decideWorkerApproval = decide;
    (stubLoops as unknown as { awaitWorkerExecution: () => Promise<null> }).awaitWorkerExecution = vi.fn(async () => null);
    process.env.LOOP_EVOLVE_ENABLED = 'true'; process.env.LOOP_EVOLVE_SPECIES = 'opencode';
    try {
      await runOneTick(new LoopDaemon(db, stubLoops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 }));
      expect(decide).toHaveBeenCalledWith('appr-sib', true, 'autonomy:test-gap-rule-v1', expect.stringContaining('maker-1'));
      expect(siblingCalls).toBe(2);
      expect(stubLoops.runDeterministicChecks).toHaveBeenCalledWith('run-1', expect.objectContaining({ lease_id: 'maker-2' }));
      expect(db.prepare("SELECT json_extract(metadata, '$.auto_approved_scope') AS s FROM worker_leases WHERE id = 'maker-2'").get()).toEqual({ s: scope });
      // without a J5 scope on the first maker the sibling is not approved
      db.prepare("UPDATE worker_leases SET metadata = '{}' WHERE id = 'maker-1'").run(); decide.mockClear(); siblingCalls = 0;
      db.prepare("UPDATE goals SET status = 'decomposed' WHERE id = ?").run(goal.id);
      await runOneTick(new LoopDaemon(db, stubLoops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 }));
      expect(decide).not.toHaveBeenCalled();
    } finally { delete process.env.LOOP_EVOLVE_ENABLED; delete process.env.LOOP_EVOLVE_SPECIES; }
  });

  it('E12: with LOOP_BANDIT_ENABLED the chosen maker species is written onto the prepared maker lease', async () => {
    seedQualifyingGoal();
    db.pragma('foreign_keys = OFF');
    db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES ('maker-1', 'run-1', 'maker', 'codex', 'prepared', '{}')").run();
    const skills = new (await import('../services/skill-evolution-engine')).SkillEvolutionEngine(db);
    for (let i = 0; i < 25; i++) skills.recordOutcome('loop-maker:doc-drift-and-small-fix-loop:opencode', { success: true, tokensUsed: 0, durationMs: 1, domain: 'd', model: 'm2' });
    for (let i = 0; i < 25; i++) skills.recordOutcome('loop-maker:doc-drift-and-small-fix-loop:codex', { success: false, tokensUsed: 0, durationMs: 1, domain: 'd' });
    (stubLoops as unknown as { assertRuntimeAvailable: () => void }).assertRuntimeAvailable = () => undefined;
    process.env.LOOP_BANDIT_ENABLED = 'true'; process.env.LOOP_BANDIT_SPECIES = 'codex,opencode@m2';
    try {
      const daemon = new LoopDaemon(db, stubLoops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
      await runOneTick(daemon);
      const lease = db.prepare("SELECT runtime, json_extract(metadata, '$.model') AS model FROM worker_leases WHERE id = 'maker-1'").get();
      expect(lease).toEqual({ runtime: 'opencode', model: 'm2' });
      expect(db.prepare("SELECT event_type FROM loop_events WHERE event_type = 'bandit_selected'").get()).toEqual({ event_type: 'bandit_selected' });
    } finally { delete process.env.LOOP_BANDIT_ENABLED; delete process.env.LOOP_BANDIT_SPECIES; }
  });

  it('defers verification while another pass still runs a reviewer (prod 2026-09-24: false regressed)', async () => {
    const goal = seedQualifyingGoal();
    process.env.LOOP_DAEMON_AUTOMATED_CHECKER_ENABLED = 'true';
    db.pragma('foreign_keys = OFF'); // the stubbed run has no loop_runs row
    db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status) VALUES ('sec-1', 'run-1', 'security_checker', 'opencode', 'running')").run();
    const daemon = new LoopDaemon(db, stubLoops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
    await runOneTick(daemon);
    expect(stubLoops.verifyLoopRun).not.toHaveBeenCalled();
    expect((db.prepare('SELECT status FROM goals WHERE id = ?').get(goal.id) as { status: string }).status).not.toBe('failed');
  });
});

describe('checker verdict extraction from an opencode event stream', () => {
  it('finds the one-line JSON verdict after a prose paragraph in the same text part', () => {
    const db0 = new Database(':memory:'); db0.exec(schema); runMigrations(db0);
    const svc = new LoopService(db0);
    const text = 'The diff is test-only.\n\n{"verdict":"accepted","notes":"ok"}';
    const stdout = [JSON.stringify({ type: 'step_start' }), JSON.stringify({ type: 'text', part: { type: 'text', text } })].join('\n');
    expect(svc.extractCheckerVerdict(stdout)).toBe('accepted');
    expect(svc.extractCheckerNotes(stdout)).toBe('ok');
  });

  it('recovers a verdict whose final brace the model dropped, and prefers the last verdict line (prod 2026-09-23)', () => {
    const db0 = new Database(':memory:'); db0.exec(schema); runMigrations(db0);
    const svc = new LoopService(db0);
    const text = 'Checked the source.\n\n{"verdict":"needs_revision","notes":"draft"}\n\n{"verdict":"accepted","notes":"final","usage":{"total_tokens":2}';
    const stdout = [JSON.stringify({ type: 'step_start' }), JSON.stringify({ type: 'text', part: { type: 'text', text } })].join('\n');
    expect(svc.extractCheckerVerdict(stdout)).toBe('accepted');
    expect(svc.extractCheckerNotes(stdout)).toBe('final');
    const garbage = [JSON.stringify({ type: 'text', part: { type: 'text', text: 'no verdict here {not json' } })].join('\n');
    expect(svc.extractCheckerVerdict(garbage)).toBe('insufficient_evidence');
  });
});
