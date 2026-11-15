import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopDaemon } from '../services/loop-daemon';
import { GoalService } from '../services/goal-service';
import type { LoopService } from '../services/loop-service';

/**
 * M2 (LOOP_STOP_CONDITIONS_MODE = off | shadow, default off). Loop contracts declare `stop_conditions` (loop-service.ts
 * LOOP_CONTRACTS) but no gate checked them. In shadow the daemon evaluates each declared condition at the point a run would
 * go on to its maker dispatch and records ONE `loop_stop_condition` judgment per run per tick: which hold, which are unknown,
 * would it stop. It never stops anything. Off (and any value other than `shadow`) is byte-identical to before.
 */
let db: Database.Database;
let goals: GoalService;
const DOC_DRIFT = 'doc-drift-and-small-fix-loop';
const CONDITIONS = ['scan_budget_exhausted', 'no_findings', 'findings_planned', 'all_gates_passed_or_human_required'];
const finding = (id: string) => ({ id, type: 'doc_drift', severity: 'low', file: 'README.md', message: 'm', evidence: 'e', suggested_fix: 's' });
/** What startLoop returns: the run carries its contract in metadata (loop-service.ts startLoop). */
const runRecord = (findings: Array<ReturnType<typeof finding>>, proposed: string[] = findings.map((f) => f.id)) => ({
  id: `run-${Math.random()}`, loop_name: DOC_DRIFT, status: findings.length ? 'planning' : 'completed', findings,
  plan: { proposed_tasks: proposed.map((finding_id) => ({ finding_id })) },
  gates: [{ name: 'read_only_discovery', status: 'pass', evidence: '' }, { name: 'tests_lint_typecheck', status: 'skipped', evidence: '' }],
  metadata: { contract: { name: DOC_DRIFT, stop_conditions: CONDITIONS }, objective_mode: false },
});
const loops = (run: () => ReturnType<typeof runRecord>) => ({
  startObjectiveLoop: vi.fn(run),
  startDocDriftAndSmallFixLoop: vi.fn(run),
  continueLoopRun: vi.fn(() => { throw new Error('test: stop before the maker'); }),
  pruneOrphanedWorktrees: vi.fn(),
});
const prev: Record<string, string | undefined> = {};
beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db);
  goals = new GoalService(db);
  for (const k of ['SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED', 'AUTHORITY_GATE', 'LOOP_STOP_CONDITIONS_MODE']) { prev[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  db.close();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
const goal = () => {
  const g = goals.createGoal({ objective: `o-${Math.random()}`, acceptance_criteria: ['Tests pass'], risk_class: 'low', metadata: { source: 'self-improvement' } });
  db.prepare("UPDATE goals SET status = 'decomposed' WHERE id = ?").run(g.id);
  return g.id;
};
const records = () => db.prepare("SELECT subject_type, subject_id, state_hash, mode, decision, reason, answers_json FROM judgments WHERE judgment = 'loop_stop_condition' ORDER BY created_at, id")
  .all() as Array<{ subject_type: string; subject_id: string; state_hash: string; mode: string; decision: string; reason: string; answers_json: string }>;
async function tickOnce(mode: string | undefined, run: () => ReturnType<typeof runRecord>) {
  if (mode === undefined) delete process.env.LOOP_STOP_CONDITIONS_MODE; else process.env.LOOP_STOP_CONDITIONS_MODE = mode;
  const l = loops(run);
  const daemon = new LoopDaemon(db, l as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
  await daemon.tick(); daemon.stop();
  await new Promise((r) => setTimeout(r, 0)); // the dispatched executeGoal settles
  return l;
}

it('shadow: LoopDaemon.tick on a run whose contract condition holds (no_findings) records one loop_stop_condition judgment, mode shadow', async () => {
  const g = goal();
  let runId = '';
  await tickOnce('shadow', () => { const r = runRecord([]); runId = r.id; return r; });
  const rows = records();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ subject_type: 'loop_run', subject_id: runId, mode: 'shadow', decision: 'would_stop' });
  const a = JSON.parse(rows[0].answers_json);
  expect(a).toMatchObject({ loop_name: DOC_DRIFT, goal_id: g, would_stop: true, verdict: 'would_stop', daemon_action: 'complete_no_findings', stopped: false });
  expect(a.holds).toContain('no_findings');
  expect(a.declared).toEqual(CONDITIONS);
  expect(a.conditions.no_findings).toMatchObject({ value: true });
  expect(a.conditions.scan_budget_exhausted).toMatchObject({ value: false });
});

it('shadow never stops: a planned run (findings_planned holds) still goes on to its maker dispatch', async () => {
  goal();
  const l = await tickOnce('shadow', () => runRecord([finding('f1')]));
  expect(l.continueLoopRun).toHaveBeenCalledTimes(1); // dispatch unchanged
  const rows = records();
  expect(rows).toHaveLength(1);
  const a = JSON.parse(rows[0].answers_json);
  expect(a).toMatchObject({ verdict: 'would_stop', daemon_action: 'dispatch', stopped: false });
  expect(a.holds).toEqual(['findings_planned']);
});

it('shadow: one row per run per tick; a second tick on another goal writes its own row with its own tick id', async () => {
  goal();
  await tickOnce('shadow', () => runRecord([]));
  goal();
  await tickOnce('shadow', () => runRecord([]));
  const rows = records();
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((r) => r.subject_id)).size).toBe(2);
  expect(new Set(rows.map((r) => r.state_hash)).size).toBe(2);
});

it('off (unset, off, or any other value) is byte-identical: no loop_stop_condition row and the same goals, judgments and loop calls as shadow minus its row', async () => {
  const snapshot = () => ({
    goals: db.prepare('SELECT status FROM goals ORDER BY status').all(),
    judgments: db.prepare("SELECT judgment, subject_type, mode, decision FROM judgments WHERE judgment != 'loop_stop_condition' ORDER BY judgment").all(),
  });
  const outcomes: Array<{ snap: ReturnType<typeof snapshot>; calls: number[] }> = [];
  for (const mode of [undefined, 'off', 'on', 'enforce', 'shadow']) {
    db.close(); db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db); goals = new GoalService(db);
    goal(); goal();
    let n = 0;
    const l = await tickOnce(mode, () => runRecord(n++ === 0 ? [] : [finding('f1')]));
    if (mode !== 'shadow') expect(records(), String(mode)).toHaveLength(0);
    outcomes.push({ snap: snapshot(), calls: [l.startDocDriftAndSmallFixLoop.mock.calls.length, l.continueLoopRun.mock.calls.length] });
  }
  for (const o of outcomes.slice(1)) expect(o).toEqual(outcomes[0]);
});
