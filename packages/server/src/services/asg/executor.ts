import { randomUUID } from 'crypto';
import { isRecoverable, sha256, validateSchema, effectiveWrites, type ContractRegistry, type FailureClass, type LifecycleState, type MacroContract } from './contract';
import {
  AsgError, AttemptStore, CapabilityGate, changedPaths, diffSnapshots, digestOf, idempotencyKey, outOfScope, snapshot,
  type FsWorkspace, type ObservedEffects, type Snapshot, type WorkspaceLock,
} from './effects';
import { PROCEDURES, TEST_PATH_PATTERN, type VerifyResult } from './macros';
import { decideRoute, extractFeatures, type AsgTaskSpec, type Route, type RouteDecision } from './router';
import { redactSecrets } from '../secret-patterns';

const TEST_RE = new RegExp(TEST_PATH_PATTERN);

/**
 * ASG-001 state-based executor:
 *   SELECT → CHECK_PRECONDITIONS → EXECUTE → VERIFY → SUCCEEDED
 *                                          ↘ CLASSIFY_FAILURE → RECONCILE → MICRO_RECOVERY → VERIFY → SUCCEEDED | STOPPED
 *   any phase → BUDGET_EXHAUSTED (one shared total budget) | INTERRUPTED (abort or lease lost)
 * Rules: an exception is not "incomplete" — effects and postconditions are checked first; a verified end state after an
 * exception is SUCCEEDED with an incident recorded separately. A partial macro is reconciled from the observed workspace,
 * never by re-running it; a non-idempotent action is never repeated (write-ahead ledger). Policy refusal, invalid
 * permissions, unknown external effects, concurrent execution and lease loss are never recovered. No micro → macro return.
 * Execution status, verification status and the incident are separate fields.
 */
export type AsgState = 'SELECT' | 'CHECK_PRECONDITIONS' | 'EXECUTE' | 'VERIFY' | 'SUCCEEDED' | 'CLASSIFY_FAILURE' | 'RECONCILE' | 'MICRO_RECOVERY' | 'STOPPED' | 'BUDGET_EXHAUSTED' | 'INTERRUPTED';
export const TERMINAL: ReadonlySet<AsgState> = new Set(['SUCCEEDED', 'STOPPED', 'BUDGET_EXHAUSTED', 'INTERRUPTED']);
export const MAX_TRANSITIONS = 16;

export type MicroTool = 'read_file' | 'write_file' | 'replace_text' | 'run_test' | 'list_files' | 'done';
export interface MicroAction { tool: MicroTool | string; args: Record<string, unknown> }
export interface MacroCall { skill_id: string; version: number; input: Record<string, unknown> }
export interface RecoveryContext {
  failure_class: FailureClass; first_failure_point: string; observed_effects: ObservedEffects; applied: 'none' | 'partial' | 'full' | 'unknown';
  test_path: string | null; verifier_output: string; remaining_budget: number; hint: string; skill: string;
}
export interface MicroObservation { tool: string; ok: boolean; output: string }
export interface AgentPort {
  /** macro calls for a MACRO/HYBRID envelope, in order (the prefix inspect macro may come first) */
  macroPlan(spec: AsgTaskSpec, decision: RouteDecision, ws: FsWorkspace): MacroCall[];
  /** next micro action from the current workspace state; null or 'done' ends the micro phase */
  nextMicro(spec: AsgTaskSpec, ws: FsWorkspace, history: MicroObservation[], recovery: RecoveryContext | null): MicroAction | null;
}

export type FaultKind = 'precondition_mismatch' | 'partial_change' | 'after_completion' | 'invalid_tool_schema' | 'timeout_uncertain' | 'crash' | 'duplicate_delivery' | 'concurrent_execution';
export const FAULT_KINDS: readonly FaultKind[] = ['precondition_mismatch', 'partial_change', 'after_completion', 'invalid_tool_schema', 'timeout_uncertain', 'crash', 'duplicate_delivery', 'concurrent_execution'];
/** Faults injected into the first non-read-only macro call. duplicate_delivery / concurrent_execution are applied by the caller. */
export interface FaultPlan { kind: FaultKind; timeoutAfterWrite?: boolean }
export class SimulatedCrash extends Error { spent = 0; constructor() { super('simulated process crash'); this.name = 'SimulatedCrash'; } }

export interface CostTable { micro_action: number; macro_call: number; invalid_action: number }
export const PILOT_COST_TABLE: CostTable = { micro_action: 1, macro_call: 1, invalid_action: 1 };

export interface AsgRunOptions {
  attemptId: string;
  /** arms: B forces MICRO, C forces the lane's macro with no recovery, D = policy without recovery, E = policy + verify-before-recovery */
  forceRoute?: 'MICRO' | 'MACRO';
  recovery: boolean;
  verifyBeforeRecovery: boolean;
  budgetUnits: number;
  registry: ContractRegistry;
  executableStates: ReadonlyArray<LifecycleState>;
  store: AttemptStore;
  lock: WorkspaceLock;
  verifyTarget: (ws: FsWorkspace, testPath: string) => VerifyResult;
  fence?: () => boolean;
  signal?: { aborted: boolean };
  fault?: FaultPlan;
  costs?: CostTable;
  /** counts procedure invocations per idempotency key (invariant evidence) */
  onProcedure?: (key: string) => void;
}

export interface ActionLog { kind: 'macro' | 'micro' | 'invalid'; name: string; cost: number; ok: boolean; idempotency_key?: string; expected?: Record<string, string | null>; observed?: Record<string, string | null>; note?: string }
export interface AsgRunRecord {
  attempt_id: string; task_id: string; decision: RouteDecision; route_executed: Route;
  transitions: Array<{ from: AsgState; to: AsgState; reason: string }>;
  final_state: AsgState;
  execution_status: 'succeeded' | 'failed' | 'stopped' | 'budget_exhausted' | 'interrupted';
  verification_status: 'passed' | 'failed' | 'not_run';
  incident: { class: FailureClass | 'exception'; state: AsgState; message: string } | null;
  failure: { class: FailureClass; recoverable: boolean; first_failure_point: string } | null;
  recovery: { triggered: boolean; context: RecoveryContext | null; micro_actions: number } | null;
  compensation: { applied: boolean; paths: string[]; reason: string } | null;
  actions: ActionLog[];
  budget: { total: number; spent: number; remaining: number };
  checkpoint: { base_digest: string; base_files: number };
  effects_from_base: ObservedEffects;
  gate_refusals: number;
  duplicate_of: string | null;
}

class Stop extends Error { constructor(public readonly to: 'BUDGET_EXHAUSTED' | 'INTERRUPTED', public readonly why: string) { super(why); } }

const clip = (s: string, n = 600): string => redactSecrets(s.slice(-n)).redacted;
const err = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export function runAsg(spec: AsgTaskSpec, ws: FsWorkspace, agent: AgentPort, o: AsgRunOptions): AsgRunRecord {
  const costs = o.costs ?? PILOT_COST_TABLE;
  // duplicate delivery of the same attempt: the recorded result is returned, nothing runs again
  const prior = o.store.get(`attempt:${o.attemptId}`);
  if (prior?.state === 'completed' && prior.output) return { ...(prior.output as unknown as AsgRunRecord), duplicate_of: o.attemptId };

  // a resumed attempt (crash/restart) keeps its original decision and base: it never re-routes
  const selected = o.store.get(`select:${o.attemptId}`)?.output as { decision: RouteDecision; base: Snapshot } | undefined;
  const base: Snapshot = selected?.base ?? snapshot(ws);
  const rec: AsgRunRecord = {
    attempt_id: o.attemptId, task_id: spec.task_id, decision: null as unknown as RouteDecision, route_executed: 'MICRO', transitions: [], final_state: 'SELECT',
    execution_status: 'failed', verification_status: 'not_run', incident: null, failure: null, recovery: null, compensation: null, actions: [],
    budget: { total: o.budgetUnits, spent: 0, remaining: o.budgetUnits }, checkpoint: { base_digest: sha256(JSON.stringify(base)), base_files: Object.keys(base).length },
    effects_from_base: { created: [], modified: [], deleted: [] }, gate_refusals: 0, duplicate_of: null,
  };
  let state: AsgState = 'SELECT';
  const go = (to: AsgState, reason: string) => {
    rec.transitions.push({ from: state, to, reason });
    state = to;
    if (rec.transitions.length > MAX_TRANSITIONS) throw new Stop('BUDGET_EXHAUSTED', 'transition bound');
  };
  const guard = () => {
    if (o.signal?.aborted) throw new Stop('INTERRUPTED', 'aborted');
    if (o.fence && !o.fence()) throw new Stop('INTERRUPTED', 'lease_lost');
  };
  const spend = (n: number) => {
    if (rec.budget.spent + n > rec.budget.total) throw new Stop('BUDGET_EXHAUSTED', 'shared total budget');
    rec.budget.spent += n; rec.budget.remaining = rec.budget.total - rec.budget.spent;
  };
  const capability = spec.capability.write;
  const declaredTests = [...new Set([...spec.declared_writes.filter((p) => TEST_RE.test(p)), ...(spec.targets.test_path ? [spec.targets.test_path] : [])])];
  const verifyEndState = (): { ok: boolean; output: string } => {
    const fx = diffSnapshots(base, snapshot(ws));
    const out = outOfScope(fx, capability);
    if (out.length) return { ok: false, output: `out-of-scope effects: ${out.join(', ')}` };
    if (!declaredTests.length) return { ok: false, output: 'no declared test' };
    // the task declared these writes: an unchanged file is not done, even when its (old) test passes
    const changed = new Set(changedPaths(fx));
    const untouched = spec.declared_writes.filter((p) => !changed.has(p));
    if (untouched.length) return { ok: false, output: `declared write not made: ${untouched.join(', ')}` };
    for (const t of declaredTests) { const v = o.verifyTarget(ws, t); if (!v.passed) return { ok: false, output: v.output }; }
    return { ok: true, output: 'declared tests pass' };
  };

  // the workspace lock is the per-workspace fence: no concurrent execution or recovery
  if (!o.lock.acquire(o.attemptId)) {
    rec.decision = decideRoute(spec, extractFeatures(spec, ws), o.registry, { executableStates: o.executableStates, remainingBudget: o.budgetUnits });
    rec.failure = { class: 'concurrent_execution', recoverable: false, first_failure_point: 'SELECT' };
    go('STOPPED', 'workspace locked by another attempt');
    rec.final_state = state; rec.execution_status = 'stopped';
    return rec;
  }
  let crashed = false;
  try {
    // SELECT
    rec.decision = selected?.decision ?? decideRoute(spec, extractFeatures(spec, ws), o.registry, { executableStates: o.executableStates, remainingBudget: o.budgetUnits });
    if (!selected) o.store.put({ key: `select:${o.attemptId}`, attempt_id: o.attemptId, action_id: 'select', skill: 'route', state: 'completed', pre: {}, output: { decision: rec.decision, base } as unknown as Record<string, unknown>, at: new Date().toISOString() });
    let route: Route = rec.decision.route;
    let primary: MacroContract | null = rec.decision.skill ? o.registry.get(rec.decision.skill.skill_id, rec.decision.skill.version)?.contract ?? null : null;
    if (route !== 'STOP' && o.forceRoute === 'MICRO') { route = 'MICRO'; primary = null; }
    if (route !== 'STOP' && o.forceRoute === 'MACRO') {
      const lane = spec.lane === 'test-gap' ? 'asg:write_test_file_and_verify' : spec.lane === 'mutation' ? 'asg:replace_in_test_and_verify' : null;
      primary = lane ? o.registry.get(lane)?.contract ?? null : null;
      route = 'MACRO';
    }
    if (route === 'HYBRID' && !o.recovery) route = 'MACRO';
    rec.route_executed = route;

    if (route === 'STOP') {
      rec.failure = { class: 'policy_refusal', recoverable: false, first_failure_point: 'SELECT' };
      go('STOPPED', rec.decision.reason_codes.join(','));
      rec.execution_status = 'stopped';
      return rec;
    }

    const history: MicroObservation[] = [];
    const microGate = new CapabilityGate(capability);
    const runMicro = (recovery: RecoveryContext | null) => {
      for (let i = 0; i < 64; i++) {
        guard();
        const a = agent.nextMicro(spec, ws, history, recovery);
        if (!a || a.tool === 'done') return;
        const known = ['read_file', 'write_file', 'replace_text', 'run_test', 'list_files'].includes(a.tool);
        if (!known) { spend(costs.invalid_action); rec.actions.push({ kind: 'invalid', name: String(a.tool).slice(0, 60), cost: costs.invalid_action, ok: false, note: 'not a micro tool (no micro → macro return)' }); history.push({ tool: String(a.tool), ok: false, output: 'refused: not a micro tool' }); continue; }
        spend(costs.micro_action);
        let ok = true; let output = '';
        try {
          const p = String(a.args.path ?? '');
          if (a.tool === 'read_file') output = ws.read(p) ?? '<absent>';
          else if (a.tool === 'list_files') output = ws.list().join('\n');
          else if (a.tool === 'run_test') { const v = o.verifyTarget(ws, p); ok = v.passed; output = v.output; }
          else if (a.tool === 'write_file') { microGate.checkWrite(p); ws.write(p, String(a.args.content ?? '')); }
          else {
            const cur = ws.read(p); const parts = (cur ?? '').split(String(a.args.find ?? '\u0000'));
            if (cur === null || parts.length !== 2) { ok = false; output = 'find text not found exactly once'; }
            else { microGate.checkWrite(p); ws.write(p, parts.join(String(a.args.replace ?? ''))); }
          }
        } catch (e) {
          ok = false; output = err(e);
          if (e instanceof AsgError && e.cls === 'permission_invalid') rec.gate_refusals++;
          if (e instanceof AsgError && (e.cls === 'permission_invalid' || e.cls === 'policy_refusal')) {
            rec.actions.push({ kind: 'micro', name: a.tool, cost: costs.micro_action, ok: false, note: output });
            throw e; // never recoverable: stop the run, no detour
          }
        }
        rec.actions.push({ kind: 'micro', name: a.tool, cost: costs.micro_action, ok, note: ok ? undefined : clip(output, 120) });
        history.push({ tool: a.tool, ok, output: clip(output) });
      }
    };

    if (route === 'MICRO') {
      go('EXECUTE', `MICRO ${rec.decision.reason_codes.join(',')}${o.forceRoute ? ' (arm forces MICRO)' : ''}`);
      try { runMicro(null); } catch (e) {
        if (e instanceof Stop) throw e;
        const cls: FailureClass = e instanceof AsgError ? e.cls : 'executor_exception';
        rec.failure = { class: cls, recoverable: false, first_failure_point: 'EXECUTE:micro' };
        go('STOPPED', cls); rec.execution_status = 'stopped';
        return rec;
      }
      go('VERIFY', 'micro phase ended');
      const v = verifyEndState();
      rec.verification_status = v.ok ? 'passed' : 'failed';
      if (v.ok) { go('SUCCEEDED', 'end state verified'); rec.execution_status = 'succeeded'; }
      else { rec.failure = { class: 'validation_failure', recoverable: false, first_failure_point: 'VERIFY' }; go('STOPPED', 'verification failed (no micro recovery of a micro run in v1)'); rec.execution_status = 'stopped'; }
      return rec;
    }

    // MACRO / HYBRID
    if (!primary) {
      rec.failure = { class: 'precondition_mismatch', recoverable: false, first_failure_point: 'SELECT' };
      go('STOPPED', 'no macro contract for this task (macro-only arm cannot act)'); rec.execution_status = 'stopped';
      return rec;
    }
    // the envelope: the primary macro and the read-only inspect prefix; anything else the agent asks for is dropped
    const calls = agent.macroPlan(spec, rec.decision, ws).filter((c) => c.skill_id === primary!.skill_id || c.skill_id === 'asg:inspect_target_module');
    let failure: { cls: FailureClass; at: string; message: string; contract: MacroContract; key: string | null; expected: Record<string, string | null>; written: Map<string, string>; preimage: Map<string, string | null> } | null = null;
    let lateException: { message: string } | null = null;
    let faultUsed = false;
    for (const call of calls) {
      guard();
      const entry = o.registry.get(call.skill_id, call.version);
      const contract = entry?.contract;
      if (!contract || !PROCEDURES[`${call.skill_id}@${call.version}`]) { failure = { cls: 'tool_schema', at: 'CHECK_PRECONDITIONS', message: 'unknown macro', contract: primary, key: null, expected: {}, written: new Map(), preimage: new Map() }; break; }
      const writesSomething = contract.effects.write.length > 0;
      const fault = writesSomething && !faultUsed ? o.fault : undefined;
      if (fault) faultUsed = true;
      let input = { ...call.input };
      if (fault?.kind === 'invalid_tool_schema') { const k = contract.input_schema.required[0]; delete input[k]; }
      if (fault?.kind === 'precondition_mismatch') input = contract.skill_id === 'asg:replace_in_test_and_verify' ? { ...input, base_digest: '0'.repeat(64) } : { ...input, source_path: 'src/__asg_absent__.mjs' };
      go('CHECK_PRECONDITIONS', contract.skill_id);
      const schemaErr = validateSchema(contract.input_schema, input);
      const { allowed: allowedWrites, refused } = schemaErr ? { allowed: [], refused: [] } : effectiveWrites(contract, input, capability);
      // the key uses the attempt's base digests, so a resumed attempt finds its own write-ahead record
      const preDigests: Record<string, string | null> = Object.fromEntries(allowedWrites.map((p) => [p, base[p] ?? null]));
      const key = idempotencyKey(contract.skill_id, contract.version, input, contract.idempotency.key_fields, preDigests);
      const prev = schemaErr ? undefined : o.store.get(key);
      // a resumed action was checked before it ran; its own effects now fail its preconditions, so they are not re-checked
      const resumed = Boolean(prev && (prev.state === 'completed' || prev.state === 'started' || prev.state === 'reconciled'));
      const pre = schemaErr ? `schema: ${schemaErr}` : resumed ? null : checkPreconditions(contract, input, ws);
      if (pre || refused.length) {
        failure = { cls: schemaErr ? 'tool_schema' : refused.length ? 'permission_invalid' : 'precondition_mismatch', at: 'CHECK_PRECONDITIONS', message: pre ?? `effects outside capability: ${refused.join(',')}`, contract, key: null, expected: {}, written: new Map(), preimage: new Map() };
        spend(costs.macro_call); rec.actions.push({ kind: 'macro', name: contract.skill_id, cost: costs.macro_call, ok: false, note: failure.message.slice(0, 120) });
        break;
      }
      // EXECUTE (write-ahead ledger + checkpoint of the declared write set)
      go('EXECUTE', contract.skill_id);
      if (!resumed) spend(costs.macro_call);
      // pre-image for compensation: only known when this process ran the action
      const preimage = new Map<string, string | null>(resumed ? [] : allowedWrites.map((p) => [p, ws.read(p)]));
      const written = new Map<string, string>();
      const gate = new CapabilityGate(allowedWrites);
      let output: Record<string, unknown> | null = null; let thrown: unknown = null;
      if (resumed) {
        // restart / duplicate: never re-run; the observed workspace decides (RECONCILE)
        if (prev!.state === 'completed' && prev!.output) output = prev!.output;
        else thrown = new AsgError('timeout_uncertain', `resumed after ${prev!.state}: outcome taken from the workspace`);
      } else {
        o.store.put({ key, attempt_id: o.attemptId, action_id: randomUUID(), skill: contract.skill_id, state: 'started', pre: preDigests, at: new Date().toISOString() });
        o.onProcedure?.(key);
        const write = (p: string, content: string) => {
          gate.checkWrite(p);
          if (fault?.kind === 'partial_change') { const half = content.slice(0, Math.max(1, Math.floor(content.length / 2))); ws.write(p, half); written.set(p, sha256(half)); throw new Error('injected failure during the write'); }
          ws.write(p, content); written.set(p, sha256(content));
          if (fault?.kind === 'crash') throw new SimulatedCrash();
        };
        const before = contract.effects.write.length === 0 ? snapshot(ws) : null;
        try {
          if (fault?.kind === 'timeout_uncertain' && !fault.timeoutAfterWrite) throw new AsgError('timeout_uncertain', 'injected timeout before any effect');
          output = PROCEDURES[`${call.skill_id}@${call.version}`](input, { ws, gate, verify: (tp) => o.verifyTarget(ws, tp), write });
          if (before && changedPaths(diffSnapshots(before, snapshot(ws))).length) throw new AsgError('permission_invalid', 'read-only macro changed the workspace');
          if (fault?.kind === 'timeout_uncertain') { output = null; throw new AsgError('timeout_uncertain', 'injected timeout after the effects, outcome uncertain'); }
          if (fault?.kind === 'after_completion') throw new Error('injected failure after correct completion');
        } catch (e) {
          if (e instanceof SimulatedCrash) { crashed = true; e.spent = rec.budget.spent; throw e; }
          thrown = e;
        }
        o.store.put({ key, attempt_id: o.attemptId, action_id: o.store.get(key)!.action_id, skill: contract.skill_id, state: thrown ? 'reconciled' : 'completed', pre: preDigests,
          observed_post: Object.fromEntries(allowedWrites.map((p) => [p, digestOf(ws.read(p))])), output: thrown ? null : output, failure: thrown instanceof AsgError ? thrown.cls : thrown ? 'executor_exception' : null, at: new Date().toISOString() });
      }
      const expected: Record<string, string | null> = {};
      if (output && typeof output.written_digest === 'string') for (const p of allowedWrites) expected[p] = output.written_digest;
      rec.actions.push({ kind: 'macro', name: contract.skill_id, cost: resumed ? 0 : costs.macro_call, ok: !thrown, idempotency_key: key, expected, observed: Object.fromEntries(allowedWrites.map((p) => [p, digestOf(ws.read(p))])), note: thrown ? err(thrown) : undefined });
      if (thrown) {
        // classified from what happened: a procedure that returned and then threw is a late exception, not a partial change
        const cls: FailureClass = thrown instanceof AsgError ? thrown.cls : output === null && written.size ? 'partial_effect' : 'executor_exception';
        failure = { cls, at: `EXECUTE:${contract.skill_id}`, message: err(thrown), contract, key, expected, written, preimage };
        if (!(thrown instanceof AsgError)) lateException = { message: err(thrown) };
        break;
      }
      // VERIFY postconditions (independently re-checked, not taken from the macro's own report)
      go('VERIFY', contract.skill_id);
      const post = checkPostconditions(contract, input, output!, ws, () => o.verifyTarget(ws, String(input.test_path)));
      if (post) { failure = { cls: 'validation_failure', at: `VERIFY:${contract.skill_id}`, message: post, contract, key, expected, written, preimage }; break; }
    }

    if (!failure) {
      const v = verifyEndState();
      rec.verification_status = v.ok ? 'passed' : 'failed';
      if (v.ok) { go('SUCCEEDED', 'postconditions and end state verified'); rec.execution_status = 'succeeded'; return rec; }
      failure = { cls: 'validation_failure', at: 'VERIFY:end_state', message: v.output.slice(0, 200), contract: primary, key: null, expected: {}, written: new Map(), preimage: new Map() };
    }

    // CLASSIFY_FAILURE
    go('CLASSIFY_FAILURE', `${failure.cls} at ${failure.at}`);
    const fx = diffSnapshots(base, snapshot(ws));
    const out = outOfScope(fx, capability);
    if (out.length) failure.cls = 'permission_invalid';
    const exceptionLike = failure.cls === 'executor_exception' || failure.cls === 'timeout_uncertain' || failure.cls === 'partial_effect';
    if (exceptionLike && o.verifyBeforeRecovery) {
      // exception ≠ incomplete: the end state decides first
      go('VERIFY', 'verify before recovery');
      const v = verifyEndState();
      if (v.ok) {
        rec.verification_status = 'passed';
        rec.incident = { class: lateException ? 'exception' : failure.cls, state: 'EXECUTE', message: failure.message };
        go('SUCCEEDED', 'end state verified despite the exception (incident recorded)'); rec.execution_status = 'succeeded';
        return rec;
      }
      go('CLASSIFY_FAILURE', 'end state not verified');
    }
    const recoverable = route === 'HYBRID' && o.recovery && isRecoverable(failure.contract, failure.cls);
    rec.failure = { class: failure.cls, recoverable, first_failure_point: failure.at };
    if (!recoverable) {
      // a correct end state is never undone: compensation only when the end state does not verify
      const end = verifyEndState();
      rec.verification_status = end.ok ? 'passed' : 'failed';
      if (!end.ok) rec.compensation = compensate(failure.contract, failure.written, failure.preimage, ws, failure.cls);
      go('STOPPED', route === 'MACRO' ? 'macro_failure_no_recovery' : `not recoverable: ${failure.cls}`);
      rec.execution_status = 'stopped';
      return rec;
    }
    // RECONCILE: what actually changed, from the workspace, not from the failed call's claims
    go('RECONCILE', failure.cls);
    const applied = failure.written.size === 0 ? (failure.cls === 'timeout_uncertain' ? 'unknown' : 'none')
      : [...failure.written.keys()].every((p) => failure!.expected[p] && digestOf(ws.read(p)) === failure!.expected[p]) ? 'full'
        : failure.cls === 'timeout_uncertain' ? 'unknown' : 'partial';
    if (failure.key) { const r = o.store.get(failure.key); if (r) o.store.put({ ...r, state: 'reconciled', observed_post: Object.fromEntries([...failure.written.keys()].map((p) => [p, digestOf(ws.read(p))])), at: new Date().toISOString() }); }
    const tp = spec.targets.test_path;
    const ctx: RecoveryContext = {
      failure_class: failure.cls, first_failure_point: failure.at, observed_effects: fx, applied, test_path: tp,
      verifier_output: tp && ws.read(tp) !== null ? clip(o.verifyTarget(ws, tp).output) : '', remaining_budget: rec.budget.remaining,
      hint: failure.contract.micro_fallback.hint, skill: `${failure.contract.skill_id}@${failure.contract.version}`,
    };
    rec.recovery = { triggered: true, context: ctx, micro_actions: 0 };
    go('MICRO_RECOVERY', `from current state (${applied})`);
    const before = rec.actions.length;
    try { runMicro(ctx); } catch (e) {
      if (e instanceof Stop) throw e;
      rec.recovery.micro_actions = rec.actions.length - before;
      rec.failure = { class: e instanceof AsgError ? e.cls : 'executor_exception', recoverable: false, first_failure_point: 'MICRO_RECOVERY' };
      go('STOPPED', rec.failure.class); rec.execution_status = 'stopped'; return rec;
    }
    rec.recovery.micro_actions = rec.actions.length - before;
    go('VERIFY', 'after micro recovery');
    const v = verifyEndState();
    rec.verification_status = v.ok ? 'passed' : 'failed';
    if (v.ok) { go('SUCCEEDED', 'recovered and verified'); rec.execution_status = 'succeeded'; }
    else { go('STOPPED', 'recovery did not reach a verified end state'); rec.execution_status = 'stopped'; }
    return rec;
  } catch (e) {
    if (e instanceof Stop) {
      rec.transitions.push({ from: state, to: e.to, reason: e.why }); state = e.to;
      rec.execution_status = e.to === 'BUDGET_EXHAUSTED' ? 'budget_exhausted' : 'interrupted';
      if (e.why === 'lease_lost') rec.failure = { class: 'lease_lost', recoverable: false, first_failure_point: rec.transitions[rec.transitions.length - 2]?.to ?? 'SELECT' };
      return rec;
    }
    if (e instanceof AsgError) {
      rec.failure = { class: e.cls, recoverable: false, first_failure_point: state };
      rec.transitions.push({ from: state, to: 'STOPPED', reason: e.cls }); state = 'STOPPED'; rec.execution_status = 'stopped';
      return rec;
    }
    throw e;
  } finally {
    rec.final_state = state;
    if (!crashed) {
      rec.effects_from_base = diffSnapshots(base, snapshot(ws));
      if (TERMINAL.has(state)) o.store.put({ key: `attempt:${o.attemptId}`, attempt_id: o.attemptId, action_id: 'final', skill: 'run', state: 'completed', pre: {}, output: rec as unknown as Record<string, unknown>, at: new Date().toISOString() });
      o.lock.release(o.attemptId);
    }
  }
}

export function checkPreconditions(c: MacroContract, input: Record<string, unknown>, ws: FsWorkspace): string | null {
  for (const p of c.preconditions) {
    const path = String(input[p.path] ?? '');
    let content: string | null = null;
    try { content = ws.read(path); } catch { return `${p.id}: path refused`; }
    if (p.check === 'path_exists' && content === null) return `${p.id}: ${path} absent`;
    if (p.check === 'path_absent' && content !== null) return `${p.id}: ${path} exists`;
    if (p.check === 'path_matches' && !new RegExp(p.pattern).test(path)) return `${p.id}: ${path} does not match`;
    if (p.check === 'digest_equals' && digestOf(content) !== input[p.digest]) return `${p.id}: ${path} changed since base`;
    if (p.check === 'text_occurs_once' && (content ?? '').split(String(input[p.text] ?? '\u0000')).length !== 2) return `${p.id}: text not found exactly once`;
  }
  return null;
}

export function checkPostconditions(c: MacroContract, input: Record<string, unknown>, output: Record<string, unknown>, ws: FsWorkspace, verify: () => VerifyResult): string | null {
  for (const p of c.postconditions) {
    if (p.check === 'output_schema') { const e = validateSchema(c.output_schema, output); if (e) return `${p.id}: ${e}`; }
    if (p.check === 'file_digest_equals_output' && digestOf(ws.read(String(input[p.path]))) !== output[p.output]) return `${p.id}: file digest differs from the macro's output`;
    if (p.check === 'verifier_passes') { const v = verify(); if (!v.passed) return `${p.id}: ${v.output.slice(-160)}`; }
  }
  return null;
}

/** restore_preimage only for paths whose current digest is exactly what this macro wrote (nobody changed them since). */
function compensate(c: MacroContract, written: Map<string, string>, preimage: Map<string, string | null>, ws: FsWorkspace, cls: FailureClass): AsgRunRecord['compensation'] {
  if (!written.size) return null;
  if (c.idempotency.compensation !== 'restore_preimage') return { applied: false, paths: [], reason: 'contract has no compensation' };
  if (cls === 'permission_invalid' || cls === 'unknown_external_effect') return { applied: false, paths: [], reason: `left for review: ${cls}` };
  const paths: string[] = [];
  for (const [p, d] of written) {
    if (digestOf(ws.read(p)) !== d || !preimage.has(p)) continue; // changed by someone else since: never overwrite it
    const pre = preimage.get(p) ?? null;
    if (pre === null) ws.remove(p); else ws.write(p, pre);
    paths.push(p);
  }
  return { applied: paths.length > 0, paths, reason: paths.length ? 'restored the pre-image' : 'pre-image not known in this process (resumed attempt): left for review' };
}
