import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { allGatesPassed, type LoopGate } from './loop-types';
import { buildProvenance, provenanceJson } from './judgment-provenance';

/**
 * M2 (LOOP_STOP_CONDITIONS_MODE = off | shadow, default off). Loop contracts declare `stop_conditions` (loop-service.ts
 * LOOP_CONTRACTS, copied onto each run's metadata.contract by startLoop) but no gate ever checked them. In shadow the loop
 * daemon evaluates every declared condition at the point a run goes on to its maker dispatch (executeGoal, right after the
 * run is started or resumed) and writes ONE `loop_stop_condition` judgment per run per tick. Nothing reads it for a decision
 * and nothing is stopped: the row is the measurement. Off (and any value other than `shadow`) writes nothing.
 *
 * Each condition is evaluated only from state the run already has (findings, plan, gates, status, metadata). A condition the
 * run cannot observe is `unknown` — never true or false.
 */
export type StopConditionMode = 'off' | 'shadow';
export const stopConditionsMode = (env: NodeJS.ProcessEnv = process.env): StopConditionMode => (env.LOOP_STOP_CONDITIONS_MODE === 'shadow' ? 'shadow' : 'off');

export const STOP_CONDITION_POLICY = { id: 'loop_stop_condition', version: 1 } as const;

export interface StopConditionRun {
  findings?: ReadonlyArray<{ id: string; metadata?: Record<string, unknown> }>;
  plan?: Record<string, unknown>;
  gates?: ReadonlyArray<Pick<LoopGate, 'name' | 'status'>>;
  status?: string;
  metadata?: Record<string, unknown>;
}
/** value null = unknown (with the reason) */
export interface ConditionValue { value: boolean | null; evidence: string }
export type StopVerdict = 'would_stop' | 'continue' | 'unknown';
export interface StopEvaluation { declared: string[]; conditions: Record<string, ConditionValue>; holds: string[]; unknown: string[]; verdict: StopVerdict }

/** Statuses at which the run waits for a human (the "human_required" half of all_gates_passed_or_human_required). */
const HUMAN_REQUIRED_STATUSES = new Set(['blocked', 'ready_for_human_merge', 'escalated']);
const unknown = (evidence: string): ConditionValue => ({ value: null, evidence });

const noFindings = (run: StopConditionRun): ConditionValue => (Array.isArray(run.findings)
  ? { value: run.findings.length === 0, evidence: `findings=${run.findings.length}` } : unknown('run has no findings array'));

/** startLoop caps discovery at max_findings; the daemon starts every run without one, so its budget is DEFAULT_MAX_FINDINGS. */
const scanBudgetExhausted = (run: StopConditionRun, scanBudget: number | null): ConditionValue => {
  if (!Array.isArray(run.findings)) return unknown('run has no findings array');
  if (run.metadata?.objective_mode === true) return unknown('objective-mode run: no discovery scan ran');
  if (!scanBudget) return unknown('scan budget not known for this run');
  return { value: run.findings.length >= scanBudget, evidence: `findings=${run.findings.length}, scan_budget=${scanBudget}` };
};

/** createPlan lists one proposed task per non-split finding; "planned" = there are findings and every one has its task. */
const findingsPlanned = (run: StopConditionRun): ConditionValue => {
  if (!Array.isArray(run.findings)) return unknown('run has no findings array');
  const tasks = run.plan?.proposed_tasks;
  if (!Array.isArray(tasks)) return unknown('run has no plan.proposed_tasks');
  const planned = new Set(tasks.map((t) => (t as { finding_id?: unknown })?.finding_id).filter((id): id is string => typeof id === 'string'));
  const open = run.findings.filter((f) => f.metadata?.status !== 'split');
  if (open.length === 0) return { value: false, evidence: 'no findings to plan' };
  const missing = open.filter((f) => !planned.has(f.id)).length;
  return { value: missing === 0, evidence: `findings=${open.length}, planned=${open.length - missing}` };
};

const allGatesOrHuman = (run: StopConditionRun): ConditionValue => {
  if (!Array.isArray(run.gates) || typeof run.status !== 'string') return unknown('run has no gates or status');
  const passed = allGatesPassed(run.gates);
  const human = HUMAN_REQUIRED_STATUSES.has(run.status);
  return { value: passed || human, evidence: `all_gates_passed=${passed} (${run.gates.length} gates), status=${run.status}` };
};

const either = (a: ConditionValue, b: ConditionValue): ConditionValue => ({
  value: a.value === true || b.value === true ? true : a.value === false && b.value === false ? false : null,
  evidence: `${a.evidence}; ${b.evidence}`,
});
const validatedOrPlanned = (run: StopConditionRun) => either(noFindings(run), findingsPlanned(run));

/**
 * The machine-checkable conditions, by the name the contracts use. "<x>_planned" reads the run's plan; "validated" / "no
 * drift" is a discovery that found nothing. Not listed (always unknown): invariants about worker output or human approval
 * that no run state records — draft_skills_block_live_orchestration, security_checker_required_for_worker_output,
 * human_required_for_mutating_policy_change.
 */
const EVALUATORS: Readonly<Record<string, (run: StopConditionRun, scanBudget: number | null) => ConditionValue>> = {
  scan_budget_exhausted: scanBudgetExhausted,
  no_findings: noFindings,
  findings_planned: findingsPlanned,
  bounded_maintenance_tasks_planned: findingsPlanned,
  security_gaps_planned: findingsPlanned,
  policy_drift_findings_planned: findingsPlanned,
  all_gates_passed_or_human_required: allGatesOrHuman,
  all_skills_validated_or_findings_planned: validatedOrPlanned,
  mcp_inventory_validated_or_findings_planned: validatedOrPlanned,
  okf_drift_findings_planned_or_no_drift: validatedOrPlanned,
};
export const MACHINE_CHECKABLE_CONDITIONS = Object.keys(EVALUATORS);

/** Stop conditions are alternatives: any one that holds stops the run; none holds and one is unknown → unknown. */
export function evaluateStopConditions(declared: readonly string[], run: StopConditionRun, scanBudget: number | null): StopEvaluation {
  const conditions: Record<string, ConditionValue> = {};
  for (const name of declared) {
    const evaluate = EVALUATORS[name];
    try { conditions[name] = evaluate ? evaluate(run, scanBudget) : unknown('not machine-checkable from run state'); } catch { conditions[name] = unknown('evaluation error'); }
  }
  const holds = declared.filter((n) => conditions[n].value === true);
  const unknownNames = declared.filter((n) => conditions[n].value === null);
  const verdict: StopVerdict = holds.length ? 'would_stop' : unknownNames.length || declared.length === 0 ? 'unknown' : 'continue';
  return { declared: [...declared], conditions, holds, unknown: unknownNames, verdict };
}

export interface StopConditionRecordInput {
  runId: string; goalId: string; loopName: string; tickId: string; declared: readonly string[]; run: StopConditionRun;
  scanBudget: number | null; daemonAction: 'dispatch' | 'resume' | 'complete_no_findings';
}

/** Shadow only: one judgments row (mode 'shadow'); returns null and writes nothing when the mode is off. Never throws. */
export function recordStopConditions(db: Database, input: StopConditionRecordInput, env: NodeJS.ProcessEnv = process.env, now = new Date()): StopEvaluation | null {
  if (stopConditionsMode(env) !== 'shadow') return null;
  try {
    const at = now.toISOString();
    const e = evaluateStopConditions(input.declared, input.run, input.scanBudget);
    const reason = e.holds.length ? `holds: ${e.holds.join(', ')}` : e.unknown.length ? `unknown: ${e.unknown.join(', ')}` : e.declared.length ? 'no declared condition holds' : 'no declared stop conditions';
    const answers = { loop_name: input.loopName, goal_id: input.goalId, run_id: input.runId, tick_id: input.tickId, declared: e.declared, conditions: e.conditions,
      holds: e.holds, unknown: e.unknown, would_stop: e.verdict === 'would_stop', verdict: e.verdict, scan_budget: input.scanBudget,
      daemon_action: input.daemonAction, stopped: false, policy_id: STOP_CONDITION_POLICY.id, policy_version: STOP_CONDITION_POLICY.version };
    const provenance = provenanceJson(buildProvenance({
      writer: 'loop-daemon.stop_conditions', mode: 'shadow', state: { declared: e.declared, run: input.run }, subject: { type: 'loop_run', id: input.runId },
      stateHash: input.tickId, at, decision: e.verdict, reason, evaluator: `${STOP_CONDITION_POLICY.id}/v${STOP_CONDITION_POLICY.version}`,
      def: { id: STOP_CONDITION_POLICY.id, policyVersion: String(STOP_CONDITION_POLICY.version), questions: {}, decide: evaluateStopConditions },
    }));
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, model, created_at, provenance_json)
      VALUES (?, 'loop_stop_condition', 'loop_run', ?, ?, 'shadow', ?, ?, ?, 'rule', ?, ?)`)
      .run(randomUUID(), input.runId, input.tickId, e.verdict, reason, JSON.stringify(answers), at, provenance);
    return e;
  } catch { return null; /* telemetry only */ }
}

/**
 * Evidence (report only): per loop the would_stop / continue / unknown counts and shares in the window, the runs the
 * contract would stop while the daemon dispatched them, and per condition how often it held / was false / was unknown.
 * null counts with the mode off and no row ever recorded.
 */
export function loopStopConditionEvidence(db: Database, env: NodeJS.ProcessEnv = process.env, since: string) {
  const mode = stopConditionsMode(env);
  type Row = { decision: string; answers_json: string };
  let rows: Row[] = [];
  let total = 0;
  try {
    total = (db.prepare("SELECT COUNT(*) AS n FROM judgments WHERE judgment = 'loop_stop_condition'").get() as { n: number }).n;
    rows = db.prepare("SELECT decision, answers_json FROM judgments WHERE judgment = 'loop_stop_condition' AND created_at >= ?").all(since) as Row[];
  } catch { /* table absent */ }
  if (mode === 'off' && total === 0) return { mode, since, records: null, loops: null };
  const share = (k: number, n: number) => (n ? +(k / n).toFixed(4) : null);
  const loops = new Map<string, { n: number; would_stop: number; continue: number; unknown: number; would_stop_while_dispatched: number; conditions: Record<string, { holds: number; false: number; unknown: number }> }>();
  for (const r of rows) {
    let a: { loop_name?: string; daemon_action?: string; conditions?: Record<string, ConditionValue> } = {};
    try { a = JSON.parse(r.answers_json || '{}'); } catch { /* counted under its decision only */ }
    const name = a.loop_name ?? 'unknown';
    const l = loops.get(name) ?? { n: 0, would_stop: 0, continue: 0, unknown: 0, would_stop_while_dispatched: 0, conditions: {} };
    l.n += 1;
    if (r.decision === 'would_stop') l.would_stop += 1; else if (r.decision === 'continue') l.continue += 1; else l.unknown += 1;
    if (r.decision === 'would_stop' && a.daemon_action !== 'complete_no_findings') l.would_stop_while_dispatched += 1;
    for (const [c, v] of Object.entries(a.conditions ?? {})) {
      const s = l.conditions[c] ?? { holds: 0, false: 0, unknown: 0 };
      if (v?.value === true) s.holds += 1; else if (v?.value === false) s.false += 1; else s.unknown += 1;
      l.conditions[c] = s;
    }
    loops.set(name, l);
  }
  return {
    mode, since, records: rows.length,
    loops: [...loops].sort(([a], [b]) => a.localeCompare(b)).map(([loop_name, l]) => ({
      loop_name, ...l, would_stop_share: share(l.would_stop, l.n), continue_share: share(l.continue, l.n), unknown_share: share(l.unknown, l.n),
    })),
  };
}
