import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { canonicalJson, contractDigest, matchesAny, sha256 } from '../contract';
import { AttemptStore, FsWorkspace, WorkspaceLock, diffSnapshots, changedPaths, snapshot } from '../effects';
import { runAsg, PILOT_COST_TABLE, SimulatedCrash, type AsgRunRecord, type FaultKind, type FaultPlan, type MicroObservation } from '../executor';
import { ASG_MACROS, defaultRegistry, type VerifyResult } from '../macros';
import { FEATURE_SCHEMA_HASH, POLICY_HASH, type AsgTaskSpec } from '../router';
import { scriptedAgent, nextScriptedMicro } from './agents';
import { familySplit, fixtureTasks, type FixtureTask, type Split } from './fixtures';
import { shuffle } from './stats';

/**
 * ASG-001 mechanism-pilot harness. Every (task, arm, condition, repetition) runs in its own fresh copy of the fixture.
 * Success is decided by the hidden oracle on the final workspace (the declared tests pass and every one fails against the
 * mutant; user changes survive; nothing changed outside the capability) — never by the executor's own status.
 */
export type Arm = 'A' | 'B' | 'C' | 'D' | 'E';
export const ARMS: readonly Arm[] = ['A', 'B', 'C', 'D', 'E'];
export const MACRO_FAULTS: readonly FaultKind[] = ['precondition_mismatch', 'partial_change', 'after_completion', 'invalid_tool_schema', 'timeout_uncertain', 'crash'];
export const EXECUTOR_FAULTS: readonly FaultKind[] = ['duplicate_delivery', 'concurrent_execution'];
export const HARNESS_VERSION = 1;
export const PILOT_BUDGET_UNITS = 12;

export interface PilotRow {
  run_id: string; task_id: string; family: string; split: Split; arm: Arm; condition: 'natural' | FaultKind; fault_detail: string | null;
  repetition: number; order_index: number;
  verified: boolean; oracle_reason: string; cost_units: number;
  execution_status: string; verification_status: string; final_state: string; route: string | null; route_executed: string | null; reason_codes: string[];
  transitions: number; recovery_triggered: boolean; recovery_micro_actions: number; incident: string | null; failure_class: string | null;
  invariant_violations: string[]; macro_calls: number; micro_calls: number;
}

export const harnessVerifier = (ws: FsWorkspace, testPath: string): VerifyResult => {
  if (ws.read(testPath) === null) return { passed: false, exit: -1, output: `${testPath} absent` };
  const r = spawnSync(process.execPath, [testPath], { cwd: ws.root, timeout: 15_000, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-800);
  return { passed: r.status === 0, exit: r.status ?? -1, output: output || `exit ${r.status}` };
};

function materialise(task: FixtureTask, dir: string): FsWorkspace {
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const ws = new FsWorkspace(dir);
  for (const [p, c] of Object.entries(task.files)) ws.write(p, c);
  for (const [p, c] of Object.entries(task.userEdits ?? {})) ws.write(p, c);
  return ws;
}

/** The hidden oracle. It reads the fixture's mutant and must-keep data, which no router or agent ever sees. */
export function oracle(task: FixtureTask, ws: FsWorkspace, pristine: Record<string, string>, scratch: string): { verified: boolean; reason: string; out_of_capability: string[]; user_change_lost: boolean } {
  const fx = diffSnapshots(pristine, snapshot(ws));
  const out = changedPaths(fx).filter((p) => !matchesAny(p, task.spec.capability.write));
  const lost = Object.entries(task.mustKeep ?? {}).some(([p, s]) => !(ws.read(p) ?? '').includes(s));
  const result = (verified: boolean, reason: string) => ({ verified, reason, out_of_capability: out, user_change_lost: lost });
  if (!task.solvable) return result(false, 'unsolvable inside its permissions');
  if (out.length) return result(false, `changed outside the capability: ${out.join(',')}`);
  if (lost) return result(false, 'a user change was lost');
  const tests = task.spec.declared_writes;
  for (const t of tests) { const v = harnessVerifier(ws, t); if (!v.passed) return result(false, `${t} does not pass`); }
  if (task.mutant) {
    fs.rmSync(scratch, { recursive: true, force: true }); fs.cpSync(ws.root, scratch, { recursive: true });
    const mws = new FsWorkspace(scratch);
    for (const [p, c] of Object.entries(task.mutant)) mws.write(p, c);
    for (const t of tests) { const v = harnessVerifier(mws, t); if (v.passed) { fs.rmSync(scratch, { recursive: true, force: true }); return result(false, `${t} does not kill the mutant`); } }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return result(true, 'declared tests pass and kill the mutant');
}

/** Arm A: today's path — the agent's micro actions straight on the workspace, no ASG boundary, routing or recovery. */
function runArmA(task: FixtureTask, ws: FsWorkspace): { cost: number; micro: number } {
  const history: MicroObservation[] = []; let cost = 0;
  for (let i = 0; i < PILOT_BUDGET_UNITS; i++) {
    const a = nextScriptedMicro(task, task.spec, ws, history);
    if (!a || a.tool === 'done') break;
    cost += PILOT_COST_TABLE.micro_action;
    const p = String(a.args.path ?? ''); let ok = true; let output = '';
    try {
      if (a.tool === 'read_file') output = ws.read(p) ?? '';
      else if (a.tool === 'write_file') ws.write(p, String(a.args.content ?? ''));
      else if (a.tool === 'replace_text') { const cur = ws.read(p) ?? ''; ws.write(p, cur.split(String(a.args.find)).join(String(a.args.replace))); }
      else if (a.tool === 'run_test') { const v = harnessVerifier(ws, p); ok = v.passed; output = v.output; }
    } catch (e) { ok = false; output = String(e); }
    history.push({ tool: a.tool, ok, output });
  }
  return { cost, micro: history.length };
}

export interface PilotOptions { root: string; seed?: number; repetitions?: number; tasks?: FixtureTask[]; arms?: readonly Arm[]; conditions?: ReadonlyArray<'natural' | FaultKind> }
export interface PilotResult { manifest: Record<string, unknown>; rows: PilotRow[] }

export function runPilot(opts: PilotOptions): PilotResult {
  const seed = opts.seed ?? 20261024; const reps = opts.repetitions ?? 1;
  const tasks = opts.tasks ?? fixtureTasks(); const arms = opts.arms ?? ARMS;
  const conditions = opts.conditions ?? ['natural', ...MACRO_FAULTS, ...EXECUTOR_FAULTS];
  const startedAt = new Date().toISOString();
  const rows: PilotRow[] = [];
  const lockDir = path.join(opts.root, 'locks');
  for (let rep = 1; rep <= reps; rep++) {
    const units: Array<{ task: FixtureTask; arm: Arm; condition: 'natural' | FaultKind }> = [];
    for (const task of tasks) for (const arm of arms) for (const condition of conditions) {
      if (condition !== 'natural' && arm === 'A') continue; // injected faults target the ASG executor
      if ((MACRO_FAULTS as readonly string[]).includes(condition) && arm === 'B') continue; // no macro runs in micro-only
      units.push({ task, arm, condition });
    }
    shuffle(units, seed + rep).forEach((u, orderIndex) => rows.push(runUnit(u.task, u.arm, u.condition, rep, orderIndex, opts.root, lockDir)));
  }
  const fixturesDigest = sha256(canonicalJson(tasks.map((t) => ({ f: t.family, v: t.variant, spec: t.spec, files: t.files, userEdits: t.userEdits ?? null, solution: t.solution, mutant: t.mutant, mustKeep: t.mustKeep ?? null }))));
  const manifest = {
    experiment: 'ASG-001', kind: 'mechanism_pilot', note: 'scripted/mock agents, no model call; validates the mechanism, not an effect estimate',
    harness_version: HARNESS_VERSION, seed, repetitions: reps, started_at: startedAt, finished_at: new Date().toISOString(), node: process.version,
    policy_hash: POLICY_HASH, feature_schema_hash: FEATURE_SCHEMA_HASH,
    cost_table: PILOT_COST_TABLE, cost_table_hash: sha256(canonicalJson(PILOT_COST_TABLE)).slice(0, 16), budget_units: PILOT_BUDGET_UNITS,
    contracts: ASG_MACROS.map((c) => ({ skill_id: c.skill_id, version: c.version, digest: contractDigest(c) })),
    fixtures_digest: fixturesDigest, tasks: tasks.length, families: [...new Set(tasks.map((t) => t.family))].map((f) => ({ family: f, split: familySplit(f) })),
    arms, conditions, rows: rows.length,
  };
  return { manifest, rows };
}

function runUnit(task: FixtureTask, arm: Arm, condition: 'natural' | FaultKind, rep: number, orderIndex: number, root: string, lockDir: string): PilotRow {
  const runId = `${task.spec.task_id}.${arm}.${condition}.r${rep}`;
  const dir = path.join(root, 'ws', runId);
  const ws = materialise(task, dir);
  const pristine = snapshot(ws);
  const row: PilotRow = {
    run_id: runId, task_id: task.spec.task_id, family: task.family, split: familySplit(task.family), arm, condition, fault_detail: null, repetition: rep, order_index: orderIndex,
    verified: false, oracle_reason: '', cost_units: 0, execution_status: 'n/a', verification_status: 'n/a', final_state: 'n/a', route: null, route_executed: null, reason_codes: [],
    transitions: 0, recovery_triggered: false, recovery_micro_actions: 0, incident: null, failure_class: null, invariant_violations: [], macro_calls: 0, micro_calls: 0,
  };
  if (arm === 'A') {
    const a = runArmA(task, ws); row.cost_units = a.cost; row.micro_calls = a.micro; row.execution_status = 'no_status_recorded';
  } else {
    const spec: AsgTaskSpec = { ...task.spec, runtime: 'asg-harness', runtime_has_macro_adapter: true };
    const store = new AttemptStore(path.join(root, 'ledger', `${runId}.json`));
    const lock = new WorkspaceLock(lockDir, ws.root);
    const calls = new Map<string, number>();
    const fault: FaultPlan | undefined = (MACRO_FAULTS as readonly string[]).includes(condition) ? { kind: condition as FaultKind, timeoutAfterWrite: condition === 'timeout_uncertain' ? task.variant % 2 === 1 : undefined } : undefined;
    if (fault?.kind === 'timeout_uncertain') row.fault_detail = fault.timeoutAfterWrite ? 'timeout after the effects' : 'timeout before any effect';
    const opts = {
      attemptId: `att-${runId}`, forceRoute: arm === 'B' ? 'MICRO' as const : arm === 'C' ? 'MACRO' as const : undefined,
      recovery: arm === 'E', verifyBeforeRecovery: arm === 'E', budgetUnits: PILOT_BUDGET_UNITS, registry: defaultRegistry(),
      executableStates: ['candidate', 'replay_validated', 'heldout_validated', 'shadow', 'eligible', 'active'] as const, store, lock, verifyTarget: harnessVerifier,
      fault, onProcedure: (k: string) => calls.set(k, (calls.get(k) ?? 0) + 1),
    };
    const agent = scriptedAgent(task);
    let rec: AsgRunRecord;
    if (condition === 'concurrent_execution') {
      lock.acquire('att-other-worker');
      const before = snapshot(ws);
      rec = runAsg(spec, ws, agent, opts);
      lock.release('att-other-worker');
      if (changedPaths(diffSnapshots(before, snapshot(ws))).length || rec.actions.length) row.invariant_violations.push('acted_while_workspace_locked');
      row.fault_detail = 'workspace held by another attempt for the whole run';
    } else {
      let crashSpent = 0;
      try { rec = runAsg(spec, ws, agent, opts); } catch (e) {
        if (!(e instanceof SimulatedCrash)) throw e;
        row.fault_detail = 'process crash after the write, before the ledger completed; restarted with the same attempt and the remaining budget';
        crashSpent = e.spent;
        rec = runAsg(spec, ws, agent, { ...opts, fault: undefined, budgetUnits: PILOT_BUDGET_UNITS - crashSpent });
      }
      rec = { ...rec, budget: { total: PILOT_BUDGET_UNITS, spent: rec.budget.spent + crashSpent, remaining: PILOT_BUDGET_UNITS - rec.budget.spent - crashSpent } };
      if (condition === 'duplicate_delivery') {
        const before = snapshot(ws); const n = calls.size;
        const again = runAsg(spec, ws, agent, opts);
        if (changedPaths(diffSnapshots(before, snapshot(ws))).length || calls.size !== n || again.duplicate_of !== opts.attemptId) row.invariant_violations.push('duplicate_delivery_re_executed');
        row.fault_detail = 'the same attempt delivered twice';
      }
    }
    row.cost_units = rec.budget.spent; row.execution_status = rec.execution_status; row.verification_status = rec.verification_status; row.final_state = rec.final_state;
    row.route = rec.decision?.route ?? null; row.route_executed = rec.route_executed; row.reason_codes = rec.decision?.reason_codes ?? [];
    row.transitions = rec.transitions.length; row.recovery_triggered = rec.recovery?.triggered ?? false; row.recovery_micro_actions = rec.recovery?.micro_actions ?? 0;
    row.incident = rec.incident ? `${rec.incident.class}: ${rec.incident.message}` : null; row.failure_class = rec.failure?.class ?? null;
    row.macro_calls = rec.actions.filter((a) => a.kind === 'macro').length; row.micro_calls = rec.actions.filter((a) => a.kind === 'micro').length;
    if (rec.decision?.route === 'STOP' && rec.actions.some((a) => a.kind === 'micro')) row.invariant_violations.push('micro_detour_after_policy_refusal');
    if ([...calls.values()].some((n) => n > 1)) row.invariant_violations.push('procedure_repeated_without_reconciliation');
    if (rec.budget.spent > rec.budget.total) row.invariant_violations.push('budget_overrun');
  }
  const o = oracle(task, ws, pristine, path.join(root, 'scratch', runId));
  row.verified = o.verified; row.oracle_reason = o.reason;
  if (o.out_of_capability.length) row.invariant_violations.push(`write_outside_capability:${o.out_of_capability.join(',')}`);
  if (o.user_change_lost) row.invariant_violations.push('user_change_lost');
  fs.rmSync(dir, { recursive: true, force: true });
  return row;
}
