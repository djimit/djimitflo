import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopDaemon } from '../services/loop-daemon';
import { GoalService } from '../services/goal-service';
import type { LoopService } from '../services/loop-service';
import { checkerFamilyArm } from '../services/checker-family';

/**
 * F2 (CHECKER_FAMILY_RANDOMISE): at the automated checker dispatch of an oracle-lane goal, arm 'cross' runs the checker on
 * CHECKER_CROSS_MODEL; arm 'same' and the security checker are unchanged; off is today's behaviour.
 */
let db: Database.Database;
let stub: Record<string, ReturnType<typeof vi.fn>>;
/** the checker lease metadata at the moment executeChecker ran it */
let seen: Array<{ lease_id: string; runtime: string; metadata: Record<string, unknown> }>;
let outcomes: Array<[string, Record<string, unknown>]>;

const meta = (id: string) => JSON.parse((db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(id) as { metadata: string }).metadata) as Record<string, unknown>;
const events = (type: string) => (db.prepare('SELECT metadata FROM loop_events WHERE event_type = ?').all(type) as Array<{ metadata: string }>).map((r) => JSON.parse(r.metadata));

beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF');
  vi.stubEnv('LOOP_DAEMON_AUTOMATED_CHECKER_ENABLED', 'true');
  vi.stubEnv('LOOP_DAEMON_AUTOMATED_SECURITY_CHECKER_ENABLED', 'true');
  vi.stubEnv('DJIMITFLO_OPENCODE_MODEL', 'ollama/glm-5.2:cloud');
  vi.stubEnv('LOOP_EVOLVE_ENABLED', 'false');
  seen = []; outcomes = [];
  stub = {
    startDocDriftAndSmallFixLoop: vi.fn(() => ({ id: 'run-1', findings: [{ id: 'f', type: 't', severity: 'info', file: 'x', message: 'x', evidence: 'x', suggested_fix: 'x' }] })),
    continueLoopRun: vi.fn(() => ({ leases: [{ id: 'maker-1', role: 'maker', status: 'prepared', runtime: 'opencode' }] })),
    executeWorker: vi.fn(async () => ({})),
    runDeterministicChecks: vi.fn(() => ({ run: { status: 'verifying' }, lease: {}, checks: [] })),
    retryLoopRun: vi.fn(),
    executeChecker: vi.fn(async (_run: string, input: { lease_id: string; runtime: string }) => {
      seen.push({ lease_id: input.lease_id, runtime: input.runtime, metadata: meta(input.lease_id) });
      const [status, patch] = outcomes.shift() ?? ['completed', { verdict: 'accepted' }];
      db.prepare('UPDATE worker_leases SET status = ?, metadata = ? WHERE id = ?').run(status, JSON.stringify({ ...meta(input.lease_id), ...patch }), input.lease_id);
      return {};
    }),
    verifyLoopRun: vi.fn(() => ({ gates: [] })),
    pruneOrphanedWorktrees: vi.fn(),
  };
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

/** an oracle-lane (evolve-eligible) goal in `arm`, with a completed maker and prepared checker + security checker */
function seed(arm: 'same' | 'cross', oracle = true) {
  const goals = new GoalService(db);
  let goal;
  for (;;) {
    goal = goals.createGoal({ objective: 'Add a test', acceptance_criteria: ['Tests pass'], risk_class: 'low', metadata: oracle ? { evolve: true } : {} });
    if (checkerFamilyArm(goal.id) === arm) break;
    db.prepare("UPDATE goals SET status = 'cancelled' WHERE id = ?").run(goal.id);
  }
  db.prepare("UPDATE goals SET status = 'decomposed' WHERE id = ?").run(goal.id);
  const ins = db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, metadata, created_at) VALUES (?, 'run-1', ?, ?, ?, 'f', ?, '2026-10-10T10:00:00Z')");
  ins.run('maker-1', 'maker', 'opencode', 'completed', JSON.stringify({ model_id: 'ollama/glm-5.2:cloud', model_family: 'glm' }));
  ins.run('checker-1', 'checker', 'manual', 'prepared', JSON.stringify({ maker_lease_id: 'maker-1', requires_independent_review: true }));
  ins.run('security-1', 'security_checker', 'manual', 'prepared', JSON.stringify({ maker_lease_id: 'maker-1', requires_security_review: true }));
  return goal;
}
async function tick() {
  const daemon = new LoopDaemon(db, stub as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
  await daemon.tick(); await new Promise((r) => setImmediate(r)); daemon.stop();
}

it('off (default): behaviour identical — no model on any reviewer lease, no arm, no event', async () => {
  const goal = seed('cross');
  await tick();
  expect(seen.map((s) => [s.lease_id, s.runtime])).toEqual([['checker-1', 'opencode'], ['security-1', 'opencode']]);
  expect(seen[0].metadata).toEqual({ maker_lease_id: 'maker-1', requires_independent_review: true });
  expect(seen[1].metadata).toEqual({ maker_lease_id: 'maker-1', requires_security_review: true });
  expect(JSON.parse((db.prepare('SELECT metadata FROM goals WHERE id = ?').get(goal.id) as { metadata: string }).metadata).checker_family_arm).toBeUndefined();
  expect(events('checker_family_arm')).toEqual([]);
});

it('arm cross: the checker runs on CHECKER_CROSS_MODEL; the security checker is unchanged', async () => {
  vi.stubEnv('CHECKER_FAMILY_RANDOMISE', 'on');
  const goal = seed('cross');
  await tick();
  expect(seen.map((s) => [s.lease_id, s.runtime])).toEqual([['checker-1', 'opencode'], ['security-1', 'opencode']]);
  expect(seen[0].metadata).toMatchObject({ model: 'ollama/kimi-k3:cloud', checker_family_arm: 'cross', checker_model_family: 'kimi', maker_model_family: 'glm' });
  expect(seen[1].metadata).toEqual({ maker_lease_id: 'maker-1', requires_security_review: true });
  expect(JSON.parse((db.prepare('SELECT metadata FROM goals WHERE id = ?').get(goal.id) as { metadata: string }).metadata)).toMatchObject({ checker_family_arm: 'cross', checker_model: 'ollama/kimi-k3:cloud' });
  expect(events('checker_family_arm')).toEqual([expect.objectContaining({ goal_id: goal.id, arm: 'cross', lease_id: 'checker-1', checker_model: 'ollama/kimi-k3:cloud' })]);
});

it('arm cross with CHECKER_CROSS_MODEL set uses that model', async () => {
  vi.stubEnv('CHECKER_FAMILY_RANDOMISE', 'on'); vi.stubEnv('CHECKER_CROSS_MODEL', 'ollama/qwen3.5:cloud');
  seed('cross');
  await tick();
  expect(seen[0].metadata).toMatchObject({ model: 'ollama/qwen3.5:cloud', checker_model_family: 'qwen' });
});

it('arm same: the checker keeps the runtime default model; the arm is recorded', async () => {
  vi.stubEnv('CHECKER_FAMILY_RANDOMISE', 'on');
  const goal = seed('same');
  await tick();
  expect(seen[0].metadata).not.toHaveProperty('model');
  expect(seen[0].metadata).toMatchObject({ checker_family_arm: 'same', checker_model_id: 'ollama/glm-5.2:cloud', checker_model_family: 'glm' });
  expect(seen[1].metadata).toEqual({ maker_lease_id: 'maker-1', requires_security_review: true });
  expect(events('checker_family_arm')).toEqual([expect.objectContaining({ goal_id: goal.id, arm: 'same' })]);
});

it('a goal outside the oracle lanes is not randomised', async () => {
  vi.stubEnv('CHECKER_FAMILY_RANDOMISE', 'on');
  seed('cross', false);
  await tick();
  expect(seen[0].metadata).toEqual({ maker_lease_id: 'maker-1', requires_independent_review: true });
  expect(events('checker_family_arm')).toEqual([]);
});

it('a reviewer retry of a cross-arm checker keeps the cross model', async () => {
  vi.stubEnv('CHECKER_FAMILY_RANDOMISE', 'on'); vi.stubEnv('LOOP_REVIEWER_RETRY_ENABLED', 'true');
  seed('cross');
  outcomes = [['failed', { verdict: 'insufficient_evidence', failure_reason: 'checker_runtime_failed:exit=1,timed_out=true: ' }]];
  await tick();
  const retry = seen.find((s) => s.metadata.retry_of === 'checker-1');
  expect(retry?.metadata).toMatchObject({ model: 'ollama/kimi-k3:cloud', checker_family_arm: 'cross' });
});
