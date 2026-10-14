import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopDaemon, SELECTION_POLICY } from '../services/loop-daemon';
import { GoalService } from '../services/goal-service';
import type { LoopService } from '../services/loop-service';

/**
 * DI-001 (PR #828: task selection is deterministic and no propensity was logged → BLOCKED_CAUSAL_IDENTIFICATION). Every goal
 * the daemon dispatches writes exactly one `selection_propensity` judgment: the candidate set it was chosen from, the
 * probability of the chosen one under the policy (deterministic → 1.0, recorded honestly) and the policy id/version.
 */
let db: Database.Database;
let goals: GoalService;
const loops = () => ({
  startObjectiveLoop: vi.fn(() => ({ id: `run-${Math.random()}`, findings: [] })),
  startDocDriftAndSmallFixLoop: vi.fn(() => ({ id: `run-${Math.random()}`, findings: [] })),
  pruneOrphanedWorktrees: vi.fn(),
});
const prev: Record<string, string | undefined> = {};
beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db);
  goals = new GoalService(db);
  for (const k of ['SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED', 'AUTHORITY_GATE']) { prev[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  db.close();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
const goal = (risk: 'low' | 'high') => {
  const g = goals.createGoal({ objective: `o-${risk}-${Math.random()}`, acceptance_criteria: ['Tests pass'], risk_class: risk, metadata: { source: 'self-improvement' } });
  db.prepare("UPDATE goals SET status = 'decomposed' WHERE id = ?").run(g.id);
  return g.id;
};
const records = () => (db.prepare("SELECT subject_type, subject_id, state_hash, mode, decision, answers_json FROM judgments WHERE judgment = 'selection_propensity' ORDER BY created_at, id").all() as Array<{ subject_type: string; subject_id: string; state_hash: string; mode: string; decision: string; answers_json: string }>);

it('DI-001: one dispatched goal writes exactly one propensity record with the candidate set, p = 1.0 and the policy id/version', async () => {
  const low = goal('low'); const high = goal('high');
  const daemon = new LoopDaemon(db, loops() as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 1 });
  await daemon.tick(); daemon.stop();
  const rows = records();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ subject_type: 'goal', subject_id: high, mode: 'shadow', decision: 'selected' });
  const a = JSON.parse(rows[0].answers_json);
  expect(a).toMatchObject({ chosen: high, propensity: 1, deterministic: true, policy_id: SELECTION_POLICY.id, policy_version: SELECTION_POLICY.version, rank: 0, slots: 1 });
  expect(a.candidates).toEqual([high, low]); // the whole eligible queue, in policy order
  expect(a.candidate_count).toBe(2);
  // DI-001 B (#824): written with instrumented provenance, not the trigger's 'uninstrumented' floor
  const prov = JSON.parse((db.prepare("SELECT provenance_json FROM judgments WHERE judgment = 'selection_propensity'").get() as { provenance_json: string }).provenance_json);
  expect(prov).toMatchObject({ status: 'recorded', writer: 'loop-daemon.selection', policy_id: SELECTION_POLICY.id, policy_version: String(SELECTION_POLICY.version), execution_mode: 'shadow', model_id: null });
  expect(prov.input_digest).toMatch(/^canon\/v1:sha256:/);
});

it('DI-001: two goals dispatched in one tick → two records sharing the tick and the same candidate set; no behaviour change', async () => {
  const low = goal('low'); const high = goal('high');
  const l = loops();
  const daemon = new LoopDaemon(db, l as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
  await daemon.tick(); daemon.stop();
  const rows = records();
  expect(rows.map((r) => r.subject_id).sort()).toEqual([high, low].sort());
  expect(new Set(rows.map((r) => r.state_hash)).size).toBe(1);
  for (const r of rows) expect(JSON.parse(r.answers_json).candidates).toEqual([high, low]);
  expect(l.startDocDriftAndSmallFixLoop).toHaveBeenCalledTimes(2); // dispatch unchanged
});

it('DI-001: an empty queue writes no propensity record', async () => {
  const daemon = new LoopDaemon(db, loops() as unknown as LoopService, { pollMs: 3_600_000 });
  await daemon.tick(); daemon.stop();
  expect(records()).toHaveLength(0);
});
