import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { autoMergeEvidence } from '../services/loop-auto-merge-state';
import { VALUE_GATE_REPLAY_JUDGMENT, replayAutoMergeValueGate } from '../services/auto-merge-value-replay';

/**
 * E-assumptions C4 (re-20261030): LOOP_AUTO_MERGE_VALUE_GATE=shadow collected 0 decisions since the flip (no PRs), while the
 * retro replay of the shipped rule on the 57 past auto-merges is the only evidence for `on`. The replay writes that as one
 * shadow judgment per past merge decision (replay: true), dry-run unless applied, idempotent, and never changes a decision.
 */
let db: Database.Database;
const NOW = new Date('2026-10-30T18:00:00Z');
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); });
afterEach(() => db.close());

const KILL = (score: number, killed: number) => ({ kind: 'mutant_kill', lane: 'exports', score, killed, total: 3, ms: 1 });
const MUT = (score: number) => ({ kind: 'mutation_score', lane: 'mutation', score, ms: 1 });
const FBPA = (shadow: string, before: string) => ({ name: 'test:fail-before-pass-after', mode: 'shadow', status: 'skipped', shadow_status: shadow, before });
function seed(n: number, opts: { refs: string[]; decision?: string; graded?: unknown; checks?: unknown[]; superseded?: boolean }) {
  const run = `run-${n}`;
  db.prepare("INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json) VALUES (?, 'test', 't', 'd', 'r', 'gap_analysis', 'verified', ?)")
    .run(`si-${n}`, JSON.stringify(opts.refs));
  db.prepare("INSERT INTO goals (id, objective, risk_class, status, improvement_id) VALUES (?, 'o', 'low', 'completed', ?)").run(`g-${n}`, `si-${n}`);
  db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, gates_json, metadata, created_at) VALUES (?, ?, 'doc-drift-and-small-fix-loop', 'closed', 'completed', '[]', ?, ?)")
    .run(run, `g-${n}`, JSON.stringify({ pr_url: `https://github.com/djimit/djimitflo/pull/${n}`,
      auto_merge: { mode: 'act', decision: opts.decision ?? 'merged', reason: 'ok', at: '2026-10-20T10:00:00.000Z', pr_number: n } }), '2026-10-19T00:00:00Z');
  const meta = { deterministic_checks: [{ name: 'test:assertion-strength', mode: 'shadow', status: 'skipped', shadow_status: 'pass' }, ...(opts.checks ?? [])],
    ...(opts.graded ? { graded: opts.graded } : {}) };
  if (opts.superseded) // an older maker lease, superseded by the one below: never read
    db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, 'maker', 'opencode', 'completed', ?, ?, ?)")
      .run(`old-${n}`, run, JSON.stringify({ graded: KILL(1, 3), superseded_by_maker_lease_id: `m-${n}` }), '2026-10-19T01:00:00Z', '2026-10-19T09:00:00Z');
  db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, 'maker', 'opencode', 'completed', ?, ?, ?)")
    .run(`m-${n}`, run, JSON.stringify(meta), '2026-10-19T02:00:00Z', '2026-10-19T03:00:00Z');
}
const EXPORTS = ['test-gap:packages/server/src/services/a.ts#exports']; const GAP = ['test-gap:packages/server/src/services/b.ts']; const MUTATION = ['mutation-gap:packages/server/src/services/c.ts'];
const seedAll = () => {
  seed(1, { refs: EXPORTS, graded: KILL(0.667, 2) }); // pass
  seed(2, { refs: EXPORTS, graded: KILL(0, 0), checks: [FBPA('fail', 'seeded_mutant')] }); // low
  seed(3, { refs: MUTATION, graded: MUT(0.9) }); // pass (was read as missing)
  seed(4, { refs: GAP, checks: [FBPA('pass', 'seeded_mutant')] }); // missing: seeded-mutant FBPA is not an independent signal
  seed(5, { refs: EXPORTS, graded: KILL(0, 0), superseded: true }); // low: the superseded lease's kill 1.0 is not read
  seed(6, { refs: EXPORTS, graded: KILL(1, 3), decision: 'ineligible' }); // not a merge decision: not replayed
};
const judgments = () => db.prepare('SELECT * FROM judgments WHERE judgment = ? ORDER BY subject_id').all(VALUE_GATE_REPLAY_JUDGMENT) as Array<Record<string, string>>;

it('dry run (default): evaluates the value gate on every past auto-merge and writes nothing', () => {
  seedAll();
  const before = db.prepare('SELECT id, metadata FROM loop_runs ORDER BY id').all();
  const r = replayAutoMergeValueGate(db, { now: NOW });
  expect(r).toMatchObject({ applied: false, decisions: 5, totals: { pass: 2, low: 2, missing: 1 }, would_block: 3, written: 0, already_recorded: 0 });
  expect(r.by_lane).toEqual({ exports: { pass: 1, low: 2, missing: 0 }, mutation: { pass: 1, low: 0, missing: 0 }, 'test-gap': { pass: 0, low: 0, missing: 1 } });
  expect(r.rows.map((x) => [x.run_id, x.signal, x.would_block_value])).toEqual([
    ['run-1', 'pass', null], ['run-2', 'low', 'value_signal_low'], ['run-3', 'pass', null], ['run-4', 'missing', 'value_signal_missing'], ['run-5', 'low', 'value_signal_low']]);
  expect(judgments()).toEqual([]);
  expect(db.prepare('SELECT id, metadata FROM loop_runs ORDER BY id').all()).toEqual(before); // decisions untouched
});

it('apply: one shadow judgment per decision (replay: true), idempotent on re-run; decisions are never changed', () => {
  seedAll();
  const before = db.prepare('SELECT id, metadata FROM loop_runs ORDER BY id').all();
  expect(replayAutoMergeValueGate(db, { apply: true, now: NOW })).toMatchObject({ applied: true, decisions: 5, written: 5, already_recorded: 0 });
  const rows = judgments();
  expect(rows.map((j) => [j.subject_id, j.mode, j.decision])).toEqual([['run-1', 'shadow', 'pass'], ['run-2', 'shadow', 'low'], ['run-3', 'shadow', 'pass'], ['run-4', 'shadow', 'missing'], ['run-5', 'shadow', 'low']]);
  expect(rows.every((j) => j.subject_type === 'loop_run' && j.created_at === NOW.toISOString())).toBe(true);
  const a3 = JSON.parse(rows[2].answers_json);
  expect(a3).toMatchObject({ replay: true, lane: 'mutation', pr_number: 3, decision: 'merged', decided_at: '2026-10-20T10:00:00.000Z', graded: { kind: 'mutation_score', score: 0.9 }, would_block_value: null });
  expect(JSON.parse(rows[3].answers_json)).toMatchObject({ replay: true, fbpa: { shadow_status: 'pass', before: 'seeded_mutant' }, graded: null, would_block_value: 'value_signal_missing' });
  expect(rows[1].reason).toBe('value_signal_low');
  // re-run: nothing new, nothing duplicated
  expect(replayAutoMergeValueGate(db, { apply: true, now: new Date(NOW.getTime() + 3_600_000) })).toMatchObject({ written: 0, already_recorded: 5 });
  expect(judgments()).toHaveLength(5);
  expect(db.prepare('SELECT id, metadata FROM loop_runs ORDER BY id').all()).toEqual(before);
  // the auto-merge evidence shows the replay next to the (empty) live shadow
  expect(autoMergeEvidence(db, { LOOP_AUTO_MERGE_VALUE_GATE: 'shadow' }).value_gate.replay).toEqual({ n: 5, pass: 2, low: 2, missing: 1 });
});
