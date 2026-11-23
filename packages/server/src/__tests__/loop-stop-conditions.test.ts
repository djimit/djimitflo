import { randomUUID } from 'node:crypto';
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
const als = (items: unknown[]): any => { const a: any = { length: items.length, filter: Array.prototype.filter, map: Array.prototype.map }; items.forEach((v, i) => { a[i] = v; }); return a; };
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
  expect(e.declared).toEqual(DOC);
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

it('scan_budget_exhausted: non-array findings is unknown; absent metadata still evaluates (not unknown)', () => {
  // L42: a non-array with .length must be unknown — the guard must fire, not measure 'abc'.length
  expect(evaluateStopConditions(['scan_budget_exhausted'], { findings: 'abc' as any, metadata: {} }, 50).conditions.scan_budget_exhausted.value).toBeNull();
  // L43: metadata absent (undefined) must not throw; findings < budget → false (not unknown)
  expect(evaluateStopConditions(['scan_budget_exhausted'], { findings: [f('a')] }, 50).conditions.scan_budget_exhausted.value).toBe(false);
});

it('findings_planned: non-array findings/tasks are unknown; null tasks and non-string finding_ids are handled', () => {
  // L50: non-array findings (array-like with filter) → unknown
  expect(evaluateStopConditions(['findings_planned'], { findings: als([f('a')]), plan: planned([]) }, 50).conditions.findings_planned.value).toBeNull();
  // L52: non-array proposed_tasks (array-like with map) → unknown
  expect(evaluateStopConditions(['findings_planned'], { findings: [f('a')], plan: { proposed_tasks: als([{ finding_id: 'a' }]) } as any }, 50).conditions.findings_planned.value).toBeNull();
  // L53 OptionalChaining: a null task must not throw; 'a' is still planned
  expect(evaluateStopConditions(['findings_planned'], { findings: [f('a')], plan: { proposed_tasks: [null, { finding_id: 'a' }] } as any }, 50).conditions.findings_planned.value).toBe(true);
  // L53:118 typeof id === 'string' — a numeric finding_id does not satisfy a string finding id
  expect(evaluateStopConditions(['findings_planned'], { findings: [{ id: 123 }] as any, plan: { proposed_tasks: [{ finding_id: 123 }] } as any }, 50).conditions.findings_planned.value).toBe(false);
});

it('all_gates_passed_or_human_required: non-array gates and non-string status are unknown', () => {
  // L61:7 non-array gates with string status → unknown; mutant would proceed and evaluate allGatesPassed
  expect(evaluateStopConditions(['all_gates_passed_or_human_required'], { gates: { length: 0 } as any, status: 'running' }, 50).conditions.all_gates_passed_or_human_required.value).toBeNull();
  // L61:36 array gates with non-string status → unknown; mutant would proceed and evaluate
  expect(evaluateStopConditions(['all_gates_passed_or_human_required'], { gates: openGates, status: undefined as any }, 50).conditions.all_gates_passed_or_human_required.value).toBeNull();
});

it('validated_or_planned: every either branch — true | false | null — through no_findings/findings_planned', () => {
  // a=true (no findings), b=false (no findings to plan) → true
  expect(evaluateStopConditions(['all_skills_validated_or_findings_planned'], { findings: [], plan: planned([]) }, 50).conditions.all_skills_validated_or_findings_planned.value).toBe(true);
  // a=false (findings exist), b=false (not all planned) → false
  expect(evaluateStopConditions(['all_skills_validated_or_findings_planned'], { findings: [f('a')], plan: planned([]) }, 50).conditions.all_skills_validated_or_findings_planned.value).toBe(false);
  // a=false (findings exist), b=null (no plan) → null
  expect(evaluateStopConditions(['all_skills_validated_or_findings_planned'], { findings: [f('a')] }, 50).conditions.all_skills_validated_or_findings_planned.value).toBeNull();
  // a=null (no findings array), b=null (no findings array) → null
  expect(evaluateStopConditions(['all_skills_validated_or_findings_planned'], {}, 50).conditions.all_skills_validated_or_findings_planned.value).toBeNull();
});

it('evaluateStopConditions: an evaluator that throws is caught (unknown); declared is echoed back', () => {
  const throwing: any = new Proxy({ id: 'x' }, { get(t: any, p: string) { if (p === 'metadata') throw new Error('boom'); return t[p]; } });
  const e = evaluateStopConditions(['findings_planned'], { findings: [throwing], plan: planned([]) }, 50);
  expect(e.conditions.findings_planned.value).toBeNull();
  expect(e.conditions.findings_planned.evidence).toBe('evaluation error');
  expect(e.declared).toEqual(['findings_planned']);
});

it('record: a throw in shadow returns null; answers would_stop/stopped match the verdict', () => {
  const input = { runId: 'r1', goalId: 'g1', loopName: 'doc-drift-and-small-fix-loop', tickId: 't1', declared: DOC, run: { findings: [] }, scanBudget: 50, daemonAction: 'complete_no_findings' as const };
  // L130: throw in shadow (invalid date) → null, not undefined
  expect(recordStopConditions(db, input, { LOOP_STOP_CONDITIONS_MODE: 'shadow' }, new Date('invalid'))).toBeNull();
  // would_stop case: answers.would_stop=true, stopped=false
  recordStopConditions(db, input, { LOOP_STOP_CONDITIONS_MODE: 'shadow' });
  const ws = JSON.parse((db.prepare("SELECT answers_json FROM judgments WHERE judgment = 'loop_stop_condition' AND decision = 'would_stop'").get() as Record<string, string>).answers_json);
  expect(ws.would_stop).toBe(true);
  expect(ws.stopped).toBe(false);
  // continue case: answers.would_stop=false
  const contInput = { ...input, runId: 'r2', tickId: 't2', run: { findings: [f('a')], plan: planned([]), gates: openGates, status: 'planning', metadata: {} }, daemonAction: 'dispatch' as const };
  recordStopConditions(db, contInput, { LOOP_STOP_CONDITIONS_MODE: 'shadow' });
  const cont = JSON.parse((db.prepare("SELECT answers_json FROM judgments WHERE judgment = 'loop_stop_condition' AND decision = 'continue'").get() as Record<string, string>).answers_json);
  expect(cont.would_stop).toBe(false);
});

it('evidence: shadow with no rows is empty (not null); would_stop_while_dispatched excludes complete_no_findings', () => {
  const since = '2026-01-01T00:00:00.000Z';
  const env = { LOOP_STOP_CONDITIONS_MODE: 'shadow' };
  // L147: mode=shadow, total=0 → must not early-return null
  const empty = loopStopConditionEvidence(db, env, since);
  expect(empty.records).toBe(0);
  expect(empty.loops).toEqual([]);
  // L157:40: would_stop dispatch runs only → would_stop_while_dispatched counts them
  for (const id of ['d1', 'd2']) recordStopConditions(db, { runId: id, goalId: 'g', loopName: 'L', tickId: id, declared: ['no_findings'], run: { findings: [] }, scanBudget: 50, daemonAction: 'dispatch' }, env);
  const e = loopStopConditionEvidence(db, env, since);
  expect(e.loops![0].would_stop_while_dispatched).toBe(2);
});

it('evidence: per-condition tallies handle null/false/true values; loops sorted by name', () => {
  const since = '2026-01-01T00:00:00.000Z';
  const env = { LOOP_STOP_CONDITIONS_MODE: 'shadow' };
  const insertRow = (decision: string, loopName: string, conditions: Record<string, unknown>) => db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, model, created_at, provenance_json)
    VALUES (?, 'loop_stop_condition', 'loop_run', 'r', 't', 'shadow', ?, 'r', ?, 'rule', ?, '{}')`)
    .run(randomUUID(), decision, JSON.stringify({ loop_name: loopName, conditions, daemon_action: 'dispatch' }), since);
  // L160:11 + L160:53 OptionalChaining: a null condition value must not throw
  insertRow('would_stop', 'L', { x: null });
  // L160:53 EqualityOp: value=false must tally as false, not unknown
  insertRow('continue', 'L', { y: { value: false, evidence: 'e' } });
  const e = loopStopConditionEvidence(db, env, since);
  expect(e.loops![0].conditions.x).toEqual({ holds: 0, false: 0, unknown: 1 });
  expect(e.loops![0].conditions.y).toEqual({ holds: 0, false: 1, unknown: 0 });
  // L167:28 ArrowFunction: loops sorted by name regardless of insertion order
  insertRow('would_stop', 'zzz-loop', {});
  insertRow('would_stop', 'aaa-loop', {});
  const e2 = loopStopConditionEvidence(db, env, since);
  expect(e2.loops!.map((l) => l.loop_name)).toEqual(['aaa-loop', 'L', 'zzz-loop']);
});
