import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { evaluateStopConditions, loopStopConditionEvidence, MACHINE_CHECKABLE_CONDITIONS, recordStopConditions, stopConditionsMode } from '../services/loop-stop-conditions';
import { DEFAULT_MAX_FINDINGS, loopContractStopConditions } from '../services/loop-service';
import { LOOP_CATALOG } from '@djimitflo/shared';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); });
afterEach(() => db.close());

const f = (id: string, split = false) => ({ id, ...(split ? { metadata: { status: 'split' } } : {}) });
const planned = (ids: string[]) => ({ proposed_tasks: ids.map((finding_id) => ({ finding_id })) });
const DOC = ['scan_budget_exhausted', 'no_findings', 'findings_planned', 'all_gates_passed_or_human_required'];
const passGates = [{ name: 'tests_lint_typecheck', status: 'pass' as const }, { name: 'checker_verdict', status: 'pass' as const }];
const openGates = [{ name: 'tests_lint_typecheck', status: 'skipped' as const }];

it('mode: only the literal shadow records; unset / off / anything else is off', () => {
  expect(stopConditionsMode({})).toBe('off');
  for (const v of ['off', 'on', 'enforce', 'SHADOW', '']) expect(stopConditionsMode({ LOOP_STOP_CONDITIONS_MODE: v })).toBe('off');
  expect(stopConditionsMode({ LOOP_STOP_CONDITIONS_MODE: 'shadow' })).toBe('shadow');
});

it('continue: no declared condition holds and every one is evaluable', () => {
  const e = evaluateStopConditions(DOC, { findings: [f('a'), f('b')], plan: planned(['a']), gates: openGates, status: 'planning', metadata: {} }, DEFAULT_MAX_FINDINGS);
  expect(e).toMatchObject({ verdict: 'continue', holds: [], unknown: [] });
  expect(e.conditions.findings_planned).toMatchObject({ value: false, evidence: 'findings=2, planned=1' });
});

it('each machine-checkable condition reads only run state', () => {
  const full = Array.from({ length: 50 }, (_, i) => f(`f${i}`));
  expect(evaluateStopConditions(['scan_budget_exhausted'], { findings: full, metadata: {} }, 50).holds).toEqual(['scan_budget_exhausted']);
  expect(evaluateStopConditions(['findings_planned'], { findings: [f('a'), f('s', true)], plan: planned(['a']) }, 50).holds).toEqual(['findings_planned']); // split findings are not planned tasks
  expect(evaluateStopConditions(['findings_planned'], { findings: [], plan: planned([]) }, 50).conditions.findings_planned.value).toBe(false);
  expect(evaluateStopConditions(['all_gates_passed_or_human_required'], { gates: passGates, status: 'verifying' }, 50).verdict).toBe('would_stop');
  expect(evaluateStopConditions(['all_gates_passed_or_human_required'], { gates: openGates, status: 'ready_for_human_merge' }, 50).verdict).toBe('would_stop');
  expect(evaluateStopConditions(['all_gates_passed_or_human_required'], { gates: openGates, status: 'running' }, 50).verdict).toBe('continue');
  // "validated or planned": a discovery that found nothing, or every finding planned
  expect(evaluateStopConditions(['mcp_inventory_validated_or_findings_planned'], { findings: [], plan: planned([]) }, 50).verdict).toBe('would_stop');
  expect(evaluateStopConditions(['okf_drift_findings_planned_or_no_drift'], { findings: [f('a')], plan: planned([]) }, 50).verdict).toBe('continue');
});

it('unknown is never true or false: unobservable conditions, missing state, objective-mode scan budget, no declared conditions', () => {
  const e = evaluateStopConditions(['draft_skills_block_live_orchestration', 'security_checker_required_for_worker_output', 'human_required_for_mutating_policy_change'], { findings: [f('a')] }, 50);
  expect(e).toMatchObject({ verdict: 'unknown', holds: [] });
  expect(e.unknown).toHaveLength(3);
  expect(evaluateStopConditions(['findings_planned'], { findings: [f('a')] }, 50).conditions.findings_planned.value).toBeNull(); // no plan
  expect(evaluateStopConditions(['scan_budget_exhausted'], { findings: [f('a')], metadata: { objective_mode: true } }, 50).conditions.scan_budget_exhausted.value).toBeNull();
  expect(evaluateStopConditions(['scan_budget_exhausted'], { findings: [f('a')], metadata: {} }, null).conditions.scan_budget_exhausted.value).toBeNull();
  expect(evaluateStopConditions([], { findings: [] }, 50).verdict).toBe('unknown');
  // one holds → would_stop even with others unknown; none holds and one unknown → unknown
  expect(evaluateStopConditions(['no_findings', 'draft_skills_block_live_orchestration'], { findings: [] }, 50).verdict).toBe('would_stop');
  expect(evaluateStopConditions(['no_findings', 'draft_skills_block_live_orchestration'], { findings: [f('a')] }, 50).verdict).toBe('unknown');
});

it('every catalog loop has its contract conditions; the machine-checkable set is named', () => {
  for (const { name } of LOOP_CATALOG) expect(loopContractStopConditions(name)?.length, name).toBeGreaterThan(0);
  expect(loopContractStopConditions('evolution-gym')).toBeNull();
  expect(loopContractStopConditions('doc-drift-and-small-fix-loop')).toEqual(DOC);
  expect(MACHINE_CHECKABLE_CONDITIONS).toEqual(expect.arrayContaining(DOC));
});

it('record: off writes nothing; shadow writes one shadow row with provenance', () => {
  const input = { runId: 'r1', goalId: 'g1', loopName: 'doc-drift-and-small-fix-loop', tickId: 't1', declared: DOC, run: { findings: [] }, scanBudget: 50, daemonAction: 'complete_no_findings' as const };
  expect(recordStopConditions(db, input, {})).toBeNull();
  expect(recordStopConditions(db, input, { LOOP_STOP_CONDITIONS_MODE: 'off' })).toBeNull();
  expect(db.prepare("SELECT COUNT(*) AS n FROM judgments").get()).toEqual({ n: 0 });
  expect(recordStopConditions(db, input, { LOOP_STOP_CONDITIONS_MODE: 'shadow' })?.verdict).toBe('would_stop');
  const row = db.prepare("SELECT * FROM judgments WHERE judgment = 'loop_stop_condition'").get() as Record<string, string>;
  expect(row).toMatchObject({ subject_type: 'loop_run', subject_id: 'r1', state_hash: 't1', mode: 'shadow', decision: 'would_stop', model: 'rule' });
  expect(JSON.parse(row.provenance_json)).toMatchObject({ status: 'recorded', writer: 'loop-daemon.stop_conditions', policy_id: 'loop_stop_condition', execution_mode: 'shadow' });
});

it('evidence: null with the mode off and no row; per loop would_stop / continue / unknown counts, shares and per-condition tallies', () => {
  const since = '2026-01-01T00:00:00.000Z';
  expect(loopStopConditionEvidence(db, {}, since)).toEqual({ mode: 'off', since, records: null, loops: null });
  const env = { LOOP_STOP_CONDITIONS_MODE: 'shadow' };
  const base = { goalId: 'g', loopName: 'doc-drift-and-small-fix-loop', declared: DOC, scanBudget: 50 };
  recordStopConditions(db, { ...base, runId: 'a', tickId: '1', run: { findings: [] }, daemonAction: 'complete_no_findings' }, env);
  recordStopConditions(db, { ...base, runId: 'b', tickId: '2', run: { findings: [f('x')], plan: planned(['x']), gates: openGates, status: 'planning', metadata: {} }, daemonAction: 'dispatch' }, env);
  recordStopConditions(db, { ...base, runId: 'c', tickId: '3', run: { findings: [f('x')], plan: planned([]), gates: openGates, status: 'planning', metadata: {} }, daemonAction: 'dispatch' }, env);
  recordStopConditions(db, { ...base, loopName: 'skill-quality-loop', declared: ['draft_skills_block_live_orchestration'], runId: 'd', tickId: '4', run: { findings: [f('x')] }, daemonAction: 'dispatch' }, env);
  const e = loopStopConditionEvidence(db, env, since);
  expect(e.records).toBe(4);
  const doc = e.loops!.find((l) => l.loop_name === 'doc-drift-and-small-fix-loop')!;
  expect(doc).toMatchObject({ n: 3, would_stop: 2, continue: 1, unknown: 0, would_stop_while_dispatched: 1, would_stop_share: 0.6667, continue_share: 0.3333, unknown_share: 0 });
  expect(doc.conditions.findings_planned).toEqual({ holds: 1, false: 1, unknown: 1 }); // run a has no plan: unknown, not false
  expect(e.loops!.find((l) => l.loop_name === 'skill-quality-loop')).toMatchObject({ n: 1, unknown: 1, unknown_share: 1 });
  // the mode off with rows already recorded still reports them
  expect(loopStopConditionEvidence(db, {}, since).records).toBe(4);
});
