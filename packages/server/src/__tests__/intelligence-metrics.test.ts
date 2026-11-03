import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { buildEvolutionEvidence } from '../services/evolution-evidence';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { attributionBackfill } from '../services/outcome-attribution';
import { INTELLIGENCE_CONTRACT_VERSION, INTELLIGENCE_METRIC_IDS, failureRecurrence, failureSignature, normaliseErrorClass } from '../services/intelligence-metrics';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const ago = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
let db: Database.Database;
afterEach(() => db?.close());

function fresh(): Database.Database {
  const d = new Database(':memory:'); d.exec(schema); runMigrations(d); d.pragma('foreign_keys = OFF'); new SkillEvolutionEngine(d);
  return d;
}

it('§16 step 1: every contract metric is present, version-stamped and never 0 when the evidence is missing (empty schema)', () => {
  db = new Database(':memory:'); // no tables at all: every query fails soft
  const { intelligence } = buildEvolutionEvidence(db, {}, NOW);
  expect(intelligence.contract_version).toBe(INTELLIGENCE_CONTRACT_VERSION);
  expect(intelligence.metrics.map((m) => m.metric_id)).toEqual([...INTELLIGENCE_METRIC_IDS]);
  for (const m of intelligence.metrics) {
    expect(m.version).toBe(INTELLIGENCE_CONTRACT_VERSION);
    expect(m.status).not.toBe('ok');
    expect(m.value).toBeNull(); expect(m.ci).toBeNull();
    expect(typeof m.blocker).toBe('string'); expect(m.blocker!.length).toBeGreaterThan(0);
  }
});

it('§16 step 1: a migrated but empty database is INSUFFICIENT_EVIDENCE (or UNDEFINED for GTI), with value null — never 0', () => {
  db = fresh();
  const { intelligence } = buildEvolutionEvidence(db, {}, NOW);
  const by = Object.fromEntries(intelligence.metrics.map((m) => [m.metric_id, m]));
  expect(by.GTI.status).toBe('UNDEFINED');
  for (const id of INTELLIGENCE_METRIC_IDS.filter((x) => x !== 'GTI')) {
    expect(by[id].status, id).toBe('INSUFFICIENT_EVIDENCE');
    expect(by[id].value, id).toBeNull();
  }
});

it('§16 step 1: CIA below the minimum n per arm is INSUFFICIENT_EVIDENCE with n reported; at the minimum it is ok with a CI', () => {
  db = fresh();
  const goal = db.prepare("INSERT INTO goals (id, objective, risk_class, status, improvement_id, metadata, created_at, updated_at) VALUES (?, 't', 'low', 'completed', ?, ?, ?, ?)");
  const si = db.prepare("INSERT INTO self_improvements (id, type, title, description, rationale, source, status, created_at, updated_at) VALUES (?, 'feature', 't', 'd', 'r', 'test-gap', ?, ?, ?)");
  const add = (arm: 'on' | 'off', i: number, ok: boolean) => {
    si.run(`s-${arm}-${i}`, ok ? 'verified' : 'regressed', ago(2), ago(1));
    goal.run(`g-${arm}-${i}`, `s-${arm}-${i}`, JSON.stringify({ effort_arm: arm }), ago(2), ago(1));
  };
  for (let i = 0; i < 10; i++) { add('on', i, i % 2 === 0); add('off', i, i % 3 === 0); }
  let cia = buildEvolutionEvidence(db, {}, NOW).intelligence.metrics.find((m) => m.metric_id === 'CIA')!;
  expect(cia.status).toBe('INSUFFICIENT_EVIDENCE'); expect(cia.value).toBeNull(); expect(cia.n).toBe(20);
  expect(cia.blocker).toMatch(/93/);
  for (let i = 10; i < 93; i++) { add('on', i, i % 2 === 0); add('off', i, i % 3 === 0); }
  cia = buildEvolutionEvidence(db, {}, NOW, 30).intelligence.metrics.find((m) => m.metric_id === 'CIA')!;
  expect(cia.status).toBe('ok'); expect(cia.n).toBe(186);
  expect(cia.value).toBeCloseTo(47 / 93 - 31 / 93, 3);
  expect(cia.ci![0]).toBeLessThan(cia.value!); expect(cia.ci![1]).toBeGreaterThan(cia.value!);
});

it('§16 step 1: ADQ reads the stored approval → goal link; below 30 per arm it is INSUFFICIENT_EVIDENCE with the link coverage', () => {
  db = fresh();
  db.prepare("INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode) VALUES ('t1', 't', 'd', 'completed', 'low', 'low', 'local')").run();
  db.prepare("INSERT INTO self_improvements (id, type, title, description, rationale, source, status, created_at, updated_at) VALUES ('s1', 'feature', 't', 'd', 'r', 'test-gap', 'verified', ?, ?)").run(ago(2), ago(1));
  db.prepare("INSERT INTO goals (id, objective, risk_class, status, improvement_id, created_at, updated_at) VALUES ('g1', 't', 'low', 'completed', 's1', ?, ?)").run(ago(2), ago(1));
  db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES ('r1', 'g1', 'doc-drift-and-small-fix-loop', 'closed', 'completed', '[]', '{}', '[]', '[]', '{}', ?, ?)`).run(ago(2), ago(1));
  db.prepare(`INSERT INTO approvals (id, task_id, status, risk_level, request_type, request_message, request_data, decided_by, metadata, created_at, updated_at)
    VALUES ('a1', 't1', 'approved', 'low', 'high_risk_action', 'm', '{}', 'autonomy:oracle-lane-v1', ?, ?, ?)`).run(JSON.stringify({ goal_id: 'g1', loop_run_id: 'r1', improvement_id: 's1' }), ago(2), ago(2));
  const adq = buildEvolutionEvidence(db, {}, NOW).intelligence.metrics.find((m) => m.metric_id === 'ADQ')!;
  expect(adq.status).toBe('INSUFFICIENT_EVIDENCE'); expect(adq.value).toBeNull();
  expect(adq.n).toBe(1);
  expect(adq.detail).toMatchObject({ approved: 1, linked_stored: 1, with_outcome: 1 });
});

it('§16 step 3: failure signatures are stable and separate gates and lanes', () => {
  const a = failureSignature({ lane: 'doc-drift:opencode', refs: ['loop_run:1e224f65-c1ed-43ee-9ae1-bd5cd4598cd4', 'gate:maker_completion:fail', 'gate:security_checker_verdict:skipped'],
    reasons: ['maker_gate_failed: exit 1 in /workspace/wt-91/src/a.ts after 1234 ms (lease 5c549474-8c4a-4870-a8bd-3bc322a64ff7)'] });
  const b = failureSignature({ lane: 'doc-drift:opencode', refs: ['loop_run:5c549474-8c4a-4870-a8bd-3bc322a64ff7', 'gate:maker_completion:fail'],
    reasons: ['maker_gate_failed: exit 2 in /workspace/wt-17/src/b.ts after 99 ms (lease 1e224f65-c1ed-43ee-9ae1-bd5cd4598cd4)'] });
  expect(a).not.toBeNull();
  expect(b!.signature).toBe(a!.signature); // ids, paths and numbers stripped
  const otherGate = failureSignature({ lane: 'doc-drift:opencode', refs: ['gate:tests_lint_typecheck:fail'], reasons: ['maker_gate_failed: exit 1'] });
  expect(otherGate!.signature).not.toBe(a!.signature);
  const otherLane = failureSignature({ lane: 'test-gap:opencode', refs: ['gate:maker_completion:fail'], reasons: ['maker_gate_failed: exit 1 in /x/y.ts after 5 ms (lease 1e224f65-c1ed-43ee-9ae1-bd5cd4598cd4)'] });
  expect(otherLane!.signature).not.toBe(a!.signature);
  // failed_gates text form ("name: description") gives the same gate as the evidence ref form
  expect(failureSignature({ lane: 'l', failed_gates: ['maker_completion: Every maker must finish.'], reasons: [] })!.gate).toBe('maker_completion');
  // nothing observable → no signature (counted as missing, never a new signature)
  expect(failureSignature({ lane: 'l', refs: ['loop_run:x'], reasons: [null, ''] })).toBeNull();
  expect(normaliseErrorClass('  ')).toBeNull();
});

it('§16 step 3: failure recurrence is exposure-adjusted; an empty-reason failure never lowers it; below n it is INSUFFICIENT_EVIDENCE', () => {
  const sigs = ['g1', 'g2', 'g3'].map((g) => failureSignature({ lane: 'L', refs: [`gate:${g}:fail`], reasons: [] })!);
  const ev: Parameters<typeof failureRecurrence>[0] = [];
  let t = 0;
  const at = () => new Date(NOW - 20 * 86_400_000 + (t++) * 60_000).toISOString();
  for (const s of sigs) ev.push({ at: at(), lane: 'L', failed: true, signature: s }); // first occurrences: not exposed... except after the first
  for (let i = 0; i < 24; i++) ev.push({ at: at(), lane: 'L', failed: true, signature: sigs[i % 3] }); // repeats
  for (let i = 0; i < 10; i++) ev.push({ at: at(), lane: 'L', failed: false, signature: null }); // exposures that did not fail
  const r = failureRecurrence(ev);
  expect(r.status).toBe('ok');
  // exposed = every unit after the lane's first failure: 2 + 24 + 10 = 36; repeats = 24
  expect(r.n).toBe(36); expect(r.value).toBeCloseTo(24 / 36, 4);
  expect(r.ci![0]).toBeLessThan(r.value!); expect(r.ci![1]).toBeGreaterThan(r.value!);
  const withBlind = failureRecurrence([...ev, { at: at(), lane: 'L', failed: true, signature: null }]);
  expect(withBlind.value).toBe(r.value); expect(withBlind.n).toBe(r.n);
  expect(withBlind.detail.missing_n).toBe(1); expect(withBlind.detail.observability).toBeLessThan(1);
  const small = failureRecurrence(ev.slice(0, 10));
  expect(small.status).toBe('INSUFFICIENT_EVIDENCE'); expect(small.value).toBeNull(); expect(small.ci).toBeNull();
});

it('§16 step 3: FRR in the evidence section reads production maker outcomes with gate refs and lease reasons', () => {
  db = fresh();
  const out = db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, domain, task_id, evidence_refs_json, created_at) VALUES (?, 'loop-maker:doc-drift-and-small-fix-loop:opencode', ?, 'loop', ?, ?, ?)");
  for (let i = 0; i < 30; i++) {
    const gate = ['maker_completion', 'tests_lint_typecheck', 'diff_threshold'][i % 3];
    out.run(`o${i}`, 0, `run-${i}`, JSON.stringify([`loop_run:run-${i}`, `gate:${gate}:fail`, 'outcome_class:infra_failed']), ago(20 - i * 0.5));
  }
  out.run('ok1', 1, 'run-ok', '["loop_run:run-ok"]', ago(1));
  const frr = buildEvolutionEvidence(db, {}, NOW, 30).intelligence.metrics.find((m) => m.metric_id === 'FRR')!;
  expect(frr.status).toBe('ok');
  expect(frr.n).toBe(30); // 29 later failures + 1 success are exposed
  expect(frr.value).toBeCloseTo(27 / 30, 4);
  expect(frr.detail).toMatchObject({ failures: 30, distinct_signatures: 3, missing_n: 0 });
});

it('§16 step 3: more than 20 % failures without a signature makes FRR INSUFFICIENT_EVIDENCE (contract missing_data_policy)', () => {
  const s = (g: string) => failureSignature({ lane: 'L', refs: [`gate:${g}:fail`] })!;
  const units = Array.from({ length: 30 }, (_, i) => ({ at: ago(20 - i * 0.1), lane: 'L', failed: true, signature: s(['a', 'b', 'c'][i % 3]) }));
  expect(failureRecurrence(units).status).toBe('ok');
  const blind = Array.from({ length: 10 }, (_, i) => ({ at: ago(5 - i * 0.1), lane: 'L', failed: true, signature: null }));
  const r = failureRecurrence([...units, ...blind]);
  expect(r.status).toBe('INSUFFICIENT_EVIDENCE'); expect(r.value).toBeNull(); expect(r.blocker).toMatch(/20 %/);
});

it('§16 step 1: VIG ignores no_headroom and blind trials (they cannot show a difference) and is ok on a trial past headroom', () => {
  db = fresh();
  const t = db.prepare(`INSERT INTO genome_trial_results (trial_id, parent_id, tier_set, deciding_n, f_parent_failures, b, c, p, mined_b, mined_c, power_q8_l05, state, recorded_at, graded_mean_parent, graded_mean_mutant)
    VALUES (?, 'baseline', 'mined', 20, 3, 0, 0, 1, 0, 0, 0, ?, ?, ?, ?)`);
  t.run('g-blind', 'blind', ago(2), 0.85, 0.85); t.run('g-nh', 'no_headroom', ago(1), 0.85, null);
  let vig = buildEvolutionEvidence(db, {}, NOW).intelligence.metrics.find((m) => m.metric_id === 'VIG')!;
  expect(vig.status).toBe('INSUFFICIENT_EVIDENCE'); expect(vig.value).toBeNull(); expect(vig.blocker).toMatch(/1 blind/);
  t.run('g-pow', 'powered', ago(0.5), 0.5, 0.6);
  vig = buildEvolutionEvidence(db, {}, NOW).intelligence.metrics.find((m) => m.metric_id === 'VIG')!;
  expect(vig.status).toBe('ok'); expect(vig.value).toBeCloseTo(0.1, 4); expect(vig.n).toBe(20);
});

// ── §16 step 3 (plan): read-only attribution backfill; step 4: CAR from operator audit labels ─────────────────────────

/** One settled production run: loop run + maker lease (+ checker) + its maker outcome, optionally already attributed. */
function settledRun(d: Database.Database, id: string, o: { lane?: string; gates?: string[]; maker?: { status: string; meta: Record<string, unknown> } | null;
  checker?: { status: string; verdict?: string }; success: boolean; at: string; attributed?: string; improvement?: string }) {
  const lane = o.lane ?? 'doc-drift-and-small-fix-loop';
  if (o.improvement) {
    d.prepare("INSERT INTO self_improvements (id, type, title, description, rationale, source, status, created_at, updated_at) VALUES (?, 'feature', 't', 'd', 'r', 'test-gap', ?, ?, ?)")
      .run(o.improvement, o.success ? 'verified' : 'regressed', o.at, o.at);
    d.prepare("INSERT INTO goals (id, objective, risk_class, status, improvement_id, created_at, updated_at) VALUES (?, 't', 'low', 'completed', ?, ?, ?)").run(`g-${id}`, o.improvement, o.at, o.at);
  }
  d.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, ?, ?, 'closed', ?, '[]', '{}', '[]', '[]', ?, ?, ?)`).run(id, o.improvement ? `g-${id}` : null, lane, o.success ? 'completed' : 'blocked',
    JSON.stringify(o.gates?.length ? { failed_gates: o.gates } : {}), o.at, o.at);
  const maker = o.maker === undefined ? { status: 'completed', meta: { exit_status: 0, completed_at: 'x', changed_files: ['a.ts'] } } : o.maker;
  if (maker) d.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, 'maker', 'opencode', ?, ?, ?, ?)")
    .run(`m-${id}`, id, maker.status, JSON.stringify(maker.meta), o.at, o.at);
  if (o.checker) d.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, 'checker', 'opencode', ?, ?, ?, ?)")
    .run(`c-${id}`, id, o.checker.status, JSON.stringify({ maker_lease_id: `m-${id}`, ...(o.checker.verdict ? { verdict: o.checker.verdict } : {}) }), o.at, o.at);
  d.prepare("INSERT INTO skill_outcomes (id, skill_id, agent_id, success, domain, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(`o-${id}`, `loop-maker:${lane}:opencode`, maker ? `m-${id}` : null, o.success ? 1 : 0, lane, id, o.at);
  if (o.attributed) d.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
    VALUES (?, 'outcome_attribution', 'loop_run', ?, ?, 'annotation', ?, 'computed', '{"computed":true}', ?)`).run(`oa-${id}`, id, o.attributed, o.attributed, o.at);
}
const rowCounts = (d: Database.Database) => ['judgments', 'outcome_credits', 'self_improvements', 'loop_runs'].map((t) => {
  try { return (d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n; } catch { return -1; }
});

it('§16 step 3: the attribution backfill computes what attributeOutcome would say for unattributed settled runs — per class and lane — and writes nothing', () => {
  db = fresh();
  settledRun(db, 'r1', { success: true, at: ago(20) });
  settledRun(db, 'r2', { success: false, at: ago(19), gates: ['checker_verdict: needs an accepted verdict'], checker: { status: 'failed' } });
  settledRun(db, 'r3', { success: false, at: ago(18), gates: ['tests_lint_typecheck: exit 1'] });
  settledRun(db, 'r4', { success: false, at: ago(17), gates: ['maker_completion: never ran'], maker: null });
  // an operator annotation on the proposal (08-10 backfill style) wins over the rules; the rules alone say maker_failure
  settledRun(db, 'r5', { lane: 'test-gap', success: false, at: ago(16), gates: ['checker_verdict: x'], checker: { status: 'completed', verdict: 'rejected' }, improvement: 's5' });
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
    VALUES ('ann5', 'outcome_attribution', 'self_improvement', 's5', 'x', 'annotation', 'reviewer_failure', 'operator', ?)`).run(ago(15));
  settledRun(db, 'r6', { success: true, at: ago(1), attributed: 'verified' }); // already attributed: not in the backfill frame
  // a failed run whose failed gates were never recorded (cancelled / blocked before the gates were stored): its inputs are
  // missing, so it is excluded and counted — never classified as 'verified' from an empty gate list
  settledRun(db, 'r7', { success: false, at: ago(14) });
  // gym outcomes are not production runs
  db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, domain, task_id, created_at) VALUES ('og', 'loop-maker:evolution-gym:atomic', 0, 'gym', 'gym-1', ?)").run(ago(3));
  const before = rowCounts(db);
  const report = attributionBackfill(db);
  expect(rowCounts(db)).toEqual(before); // zero rows written
  expect(report.writes).toBe(0);
  expect(report.runs).toBe(5);
  expect(report.missing_inputs).toBe(1);
  expect(report.classes).toEqual({ maker_failure: 1, reviewer_failure: 2, environment_failure: 1, verified: 1 });
  expect(report.rules_only).toEqual({ maker_failure: 2, reviewer_failure: 1, environment_failure: 1, verified: 1 });
  expect(report.annotated).toEqual({ n: 1, agree: 0 });
  expect(report.by_lane.find((l) => l.lane === 'test-gap')).toEqual({ lane: 'test-gap', n: 1, classes: { maker_failure: 0, reviewer_failure: 1, environment_failure: 0, verified: 0 } });
  expect(report.by_lane.reduce((a, l) => a + l.n, 0)).toBe(report.runs); // strata sum to the pooled count
  expect(report.coverage).toEqual({ attributed: 1, settled: 7, value: +(1 / 7).toFixed(4) });
  expect(report.outcome_mismatch).toBe(0);
  // the intelligence section carries it as CAR coverage context, never as judgments
  const car = buildEvolutionEvidence(db, {}, NOW, 30).intelligence.metrics.find((m) => m.metric_id === 'CAR')!;
  expect(car.detail.backfill).toMatchObject({ runs: 5, classes: report.classes });
  expect(car.detail.coverage).toEqual(report.coverage);
  expect(rowCounts(db)).toEqual(before);
});

it('§16 step 4: CAR = correct / audited operator labels (latest label per run, unclear stays in the denominator); ok only at ≥ 40 with ≥ 10 per class', () => {
  db = fresh();
  const label = db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
    VALUES (?, 'attribution_audit', 'loop_run', ?, ?, 'operator_label', ?, 'by op', ?)`);
  const classes = ['maker_failure', 'reviewer_failure', 'environment_failure', 'verified'];
  let i = 0;
  const audit = (cls: string, verdict: string) => { label.run(`a${i}`, `run-${cls}-${i}`, cls, verdict, ago(2)); i++; };
  for (const c of classes) for (let k = 0; k < 5; k++) audit(c, k === 0 ? 'wrong' : 'correct');
  let car = buildEvolutionEvidence(db, {}, NOW).intelligence.metrics.find((m) => m.metric_id === 'CAR')!;
  expect(car.status).toBe('INSUFFICIENT_EVIDENCE'); expect(car.value).toBeNull(); expect(car.n).toBe(20);
  expect(car.blocker).toMatch(/40/);
  for (const c of classes) for (let k = 0; k < 5; k++) audit(c, k === 0 ? 'unclear' : 'correct');
  // a run relabelled later: the newest label wins (one unit per run)
  label.run('relabel', 'run-maker_failure-0', 'maker_failure', 'correct', ago(1));
  car = buildEvolutionEvidence(db, {}, NOW).intelligence.metrics.find((m) => m.metric_id === 'CAR')!;
  expect(car.status).toBe('ok'); expect(car.n).toBe(40);
  // 32 correct + 1 relabelled = 33; wrong 3; unclear 4 (counted in the denominator, reported apart)
  expect(car.value).toBeCloseTo(33 / 40, 4);
  expect(car.ci![0]).toBeLessThan(car.value!); expect(car.ci![1]).toBeGreaterThan(car.value!);
  expect(car.detail).toMatchObject({ audited: 40, correct: 33, wrong: 3, unclear: 4 });
  expect((car.detail.per_class as Record<string, { audited: number }>).maker_failure.audited).toBe(10);
});
