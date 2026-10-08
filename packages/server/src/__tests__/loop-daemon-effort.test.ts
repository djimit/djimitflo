import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopDaemon } from '../services/loop-daemon';
import { GoalService } from '../services/goal-service';
import type { LoopService } from '../services/loop-service';
import { siblingArm } from '../services/effort-controller';

/** EVC effort controller (shadow) and X1 sibling randomisation at the evolve-sibling decision of the loop daemon. */
let db: Database.Database;
let goals: GoalService;
const stub = () => ({
  startDocDriftAndSmallFixLoop: vi.fn(() => ({ id: 'run-1', findings: [{ id: 'f1', type: 'test_finding', severity: 'info', file: 'x', message: 'x', evidence: 'x', suggested_fix: 'x' }] })),
  continueLoopRun: vi.fn(() => ({ leases: [{ id: 'maker-1', role: 'maker', status: 'prepared', runtime: 'codex' }, { id: 'checker-1', role: 'checker', status: 'prepared', runtime: 'manual' }] })),
  executeWorker: vi.fn(async () => ({})),
  runDeterministicChecks: vi.fn(() => ({ run: { status: 'completed' }, lease: {}, checks: [] })),
  retryLoopRun: vi.fn(() => ({ retry_maker: { id: 'maker-2', role: 'maker', status: 'prepared', runtime: 'opencode' }, retry_checker: { id: 'checker-2', role: 'checker', status: 'prepared', runtime: 'manual' } })),
  executeChecker: vi.fn(async () => ({})),
  verifyLoopRun: vi.fn(() => ({ gates: [] })),
  pruneOrphanedWorktrees: vi.fn(),
});

beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db);
  goals = new GoalService(db);
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES ('run-1', 'doc-drift-and-small-fix-loop', 'closed', 'running', '[]', '{}', '[]', '[]', '{}', datetime('now'), datetime('now'))`).run();
  vi.stubEnv('LOOP_EVOLVE_ENABLED', 'true'); vi.stubEnv('LOOP_EVOLVE_SPECIES', 'opencode@ollama/kimi-k2.6:cloud');
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

/** An evolve-eligible goal whose X1 arm is `arm` (goal ids are random: draw until one lands in the arm). */
function seedGoal(arm: 'on' | 'off') {
  for (;;) {
    const goal = goals.createGoal({ objective: 'Add a test', acceptance_criteria: ['Tests pass'], risk_class: 'low', metadata: { evolve: true } });
    if (siblingArm(goal.id) === arm) { db.prepare("UPDATE goals SET status = 'decomposed' WHERE id = ?").run(goal.id); return goal; }
    db.prepare("UPDATE goals SET status = 'cancelled' WHERE id = ?").run(goal.id);
  }
}
async function tick(loops: ReturnType<typeof stub>) {
  const daemon = new LoopDaemon(db, loops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
  await daemon.tick(); await new Promise((r) => setImmediate(r)); daemon.stop();
}
const events = (type: string) => (db.prepare('SELECT metadata FROM loop_events WHERE event_type = ?').all(type) as Array<{ metadata: string }>).map((r) => JSON.parse(r.metadata));

it('shadow controller never changes behaviour: the sibling is created exactly as with the controller off, and the decision is logged', async () => {
  seedGoal('off'); // randomisation is off: the arm must not matter
  const off = stub(); await tick(off);
  expect(off.retryLoopRun).toHaveBeenCalledWith('run-1', { maker_lease_id: 'maker-1', sibling: true, runtime: 'opencode', model: 'ollama/kimi-k2.6:cloud' });
  expect(events('effort_decision')).toEqual([]);

  db.prepare("UPDATE goals SET status = 'cancelled'").run();
  seedGoal('off');
  vi.stubEnv('EFFORT_CONTROLLER_MODE', 'shadow');
  const on = stub(); await tick(on);
  expect(on.retryLoopRun.mock.calls).toEqual(off.retryLoopRun.mock.calls);
  expect(on.executeWorker.mock.calls.length).toBe(off.executeWorker.mock.calls.length);
  const [e] = events('effort_decision');
  expect(e).toMatchObject({ decision_point: 'evolve_sibling', default_option: 'opencode@ollama/kimi-k2.6:cloud' });
  expect(Object.keys(e.evc)).toEqual(['none', 'opencode@ollama/kimi-k2.6:cloud']);
});

it('X1 arm off: no evolve sibling, the arm on the goal and in an event; arm on: current behaviour', async () => {
  vi.stubEnv('EFFORT_SIBLING_RANDOMISE', 'true');
  const offGoal = seedGoal('off');
  const off = stub(); await tick(off);
  expect(off.retryLoopRun).not.toHaveBeenCalled();
  expect(JSON.parse((db.prepare('SELECT metadata FROM goals WHERE id = ?').get(offGoal.id) as { metadata: string }).metadata)).toMatchObject({ effort_arm: 'off' });
  expect(events('effort_arm')).toEqual([{ goal_id: offGoal.id, arm: 'off' }]);

  db.prepare("UPDATE goals SET status = 'cancelled'").run();
  const onGoal = seedGoal('on');
  const on = stub(); await tick(on);
  expect(on.retryLoopRun).toHaveBeenCalledWith('run-1', { maker_lease_id: 'maker-1', sibling: true, runtime: 'opencode', model: 'ollama/kimi-k2.6:cloud' });
  expect(JSON.parse((db.prepare('SELECT metadata FROM goals WHERE id = ?').get(onGoal.id) as { metadata: string }).metadata)).toMatchObject({ effort_arm: 'on' });
});

it('X1 off by default: an arm-off goal still gets its sibling and no arm is recorded', async () => {
  const g = seedGoal('off');
  const loops = stub(); await tick(loops);
  expect(loops.retryLoopRun).toHaveBeenCalled();
  expect(JSON.parse((db.prepare('SELECT metadata FROM goals WHERE id = ?').get(g.id) as { metadata: string }).metadata).effort_arm).toBeUndefined();
  expect(events('effort_arm')).toEqual([]);
});
