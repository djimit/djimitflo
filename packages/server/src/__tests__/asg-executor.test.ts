import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AttemptStore, FsWorkspace, WorkspaceLock, snapshot, diffSnapshots, changedPaths } from '../services/asg/effects';
import { runAsg, SimulatedCrash, type AgentPort, type AsgRunOptions, type FaultPlan } from '../services/asg/executor';
import { defaultRegistry } from '../services/asg/macros';
import type { AsgTaskSpec } from '../services/asg/router';
import { fixtureTasks, type FixtureTask } from '../services/asg/harness/fixtures';
import { scriptedAgent } from '../services/asg/harness/agents';
import { harnessVerifier, oracle } from '../services/asg/harness/run';

/**
 * ASG-001 invariants (operator item 10), on the mechanism-pilot fixtures with the scripted agent. The end state is always
 * judged by the hidden oracle (harness/run.ts), never by the executor's own status.
 */
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

const task = (id: string): FixtureTask => { const t = fixtureTasks().find((x) => x.spec.task_id === id); if (!t) throw new Error(id); return t; };
function setup(t: FixtureTask) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asg-exec-')); roots.push(root);
  const ws = new FsWorkspace(path.join(root, 'ws'));
  for (const [p, c] of Object.entries(t.files)) ws.write(p, c);
  for (const [p, c] of Object.entries(t.userEdits ?? {})) ws.write(p, c);
  const spec: AsgTaskSpec = { ...t.spec, runtime: 'asg-harness', runtime_has_macro_adapter: true };
  const calls = new Map<string, number>();
  const opts: AsgRunOptions = {
    attemptId: 'att-1', recovery: true, verifyBeforeRecovery: true, budgetUnits: 12, registry: defaultRegistry(),
    executableStates: ['candidate', 'replay_validated', 'heldout_validated', 'shadow', 'eligible', 'active'],
    store: new AttemptStore(path.join(root, 'ledger.json')), lock: new WorkspaceLock(path.join(root, 'locks'), ws.root), verifyTarget: harnessVerifier,
    onProcedure: (k) => calls.set(k, (calls.get(k) ?? 0) + 1),
  };
  const pristine = snapshot(ws);
  return { root, ws, spec, opts, calls, pristine, agent: scriptedAgent(t), verdict: () => oracle(t, ws, pristine, path.join(root, 'scratch')) };
}
const env = setup;
const E = { recovery: true, verifyBeforeRecovery: true };
const D = { recovery: false, verifyBeforeRecovery: false };

describe('ASG-001 executor invariants', () => {
  it('a contract mismatch never mutates the workspace (stale find text → CHECK_PRECONDITIONS fails before any write)', () => {
    const t = task('csvsplit-v1'); const s = env(t);
    const rec = runAsg(s.spec, s.ws, s.agent, { ...s.opts, ...D });
    expect(rec.failure?.class).toBe('precondition_mismatch');
    expect(rec.transitions.map((x) => x.to)).toEqual(['CHECK_PRECONDITIONS', 'EXECUTE', 'VERIFY', 'CHECK_PRECONDITIONS', 'CLASSIFY_FAILURE', 'STOPPED']);
    expect(changedPaths(diffSnapshots(s.pristine, snapshot(s.ws)))).toEqual([]);
    expect(s.calls.size).toBe(1); // only the read-only inspect ran
  });

  it('a partially failed macro is recovered from the current state by micro actions, and the oracle verifies the end state', () => {
    const t = task('slug-v1'); const s = env(t);
    const rec = runAsg(s.spec, s.ws, s.agent, { ...s.opts, ...E, fault: { kind: 'partial_change' } });
    expect(rec.failure).toMatchObject({ class: 'partial_effect', recoverable: true });
    expect(rec.recovery?.context?.applied).toBe('partial');
    expect(rec.transitions.map((x) => x.to)).toContain('RECONCILE');
    expect(rec.final_state).toBe('SUCCEEDED');
    expect(s.verdict().verified).toBe(true);
    expect([...s.calls.values()].every((n) => n === 1)).toBe(true); // the failed macro is never re-run
  });

  it('a correct end state despite a late exception: E succeeds with an incident and no recovery; D stops but never undoes the work', () => {
    const t = task('clamp-v1');
    const e = env(t); const re = runAsg(e.spec, e.ws, e.agent, { ...e.opts, ...E, fault: { kind: 'after_completion' } });
    expect(re).toMatchObject({ final_state: 'SUCCEEDED', execution_status: 'succeeded', verification_status: 'passed', recovery: null });
    expect(re.incident).toMatchObject({ class: 'exception', state: 'EXECUTE' });
    expect(re.budget.spent).toBe(2);
    const d = env(t); const rd = runAsg(d.spec, d.ws, d.agent, { ...d.opts, ...D, fault: { kind: 'after_completion' } });
    expect(rd).toMatchObject({ final_state: 'STOPPED', execution_status: 'stopped', verification_status: 'passed', compensation: null });
    expect(d.verdict().verified).toBe(true);
  });

  it('protects user changes: a test file changed after the base is never touched by the macro, and the user line survives recovery', () => {
    const t = task('dirty-v1');
    const d = env(t); const rd = runAsg(d.spec, d.ws, d.agent, { ...d.opts, ...D });
    expect(rd.failure?.class).toBe('precondition_mismatch');
    expect(changedPaths(diffSnapshots(d.pristine, snapshot(d.ws)))).toEqual([]);
    const e = env(t); runAsg(e.spec, e.ws, e.agent, { ...e.opts, ...E });
    expect(e.ws.read('test/abs.test.mjs')).toContain('// user note: keep this line');
    expect(e.verdict()).toMatchObject({ verified: true, user_change_lost: false });
  });

  it('restart after a crash reconciles from the ledger and the workspace: the macro procedure ran exactly once', () => {
    const t = task('clamp-v2'); const s = env(t);
    expect(() => runAsg(s.spec, s.ws, s.agent, { ...s.opts, ...E, fault: { kind: 'crash' } })).toThrow(SimulatedCrash);
    const resumed = runAsg(s.spec, s.ws, s.agent, { ...s.opts, ...E });
    expect(resumed.final_state).toBe('SUCCEEDED');
    expect(resumed.incident?.class).toBe('timeout_uncertain'); // outcome taken from the workspace, recorded as an incident
    expect([...s.calls.values()].every((n) => n === 1)).toBe(true); // the non-idempotent replace was never repeated
    expect(resumed.decision.route).toBe('HYBRID'); // the original decision is kept, not re-routed on the changed workspace
    expect(s.verdict().verified).toBe(true);
  });

  it('a duplicate delivery returns the recorded result and changes nothing', () => {
    const t = task('slug-v2'); const s = env(t);
    const first = runAsg(s.spec, s.ws, s.agent, { ...s.opts, ...E });
    const before = snapshot(s.ws); const n = s.calls.size;
    const again = runAsg(s.spec, s.ws, s.agent, { ...s.opts, ...E });
    expect(again.duplicate_of).toBe('att-1');
    expect(again.final_state).toBe(first.final_state);
    expect(diffSnapshots(before, snapshot(s.ws))).toEqual({ created: [], modified: [], deleted: [] });
    expect(s.calls.size).toBe(n);
  });

  it('lease loss interrupts before the next action; nothing is recovered', () => {
    const t = task('money-v1'); const s = env(t);
    let checks = 0;
    const rec = runAsg(s.spec, s.ws, s.agent, { ...s.opts, ...E, fence: () => ++checks <= 2 }); // lost after the second macro starts
    expect(rec.final_state).toBe('INTERRUPTED');
    expect(rec.failure?.class).toBe('lease_lost');
    expect(rec.actions.filter((a) => a.kind === 'micro')).toEqual([]);
  });

  it('concurrent execution: a workspace held by another attempt is never touched', () => {
    const t = task('slug-v3'); const s = env(t);
    expect(s.opts.lock.acquire('other-worker')).toBe(true);
    const rec = runAsg(s.spec, s.ws, s.agent, s.opts);
    expect(rec).toMatchObject({ final_state: 'STOPPED', failure: { class: 'concurrent_execution', recoverable: false }, actions: [] });
    expect(changedPaths(diffSnapshots(s.pristine, snapshot(s.ws)))).toEqual([]);
    expect(s.opts.lock.holder()).toBe('other-worker');
  });

  it('one shared total budget: recovery stops at BUDGET_EXHAUSTED and never overspends', () => {
    const t = task('money-v2'); const s = env(t);
    const rec = runAsg(s.spec, s.ws, s.agent, { ...s.opts, ...E, budgetUnits: 3 });
    expect(rec.final_state).toBe('BUDGET_EXHAUSTED');
    expect(rec.budget.spent).toBeLessThanOrEqual(3);
    expect(rec.recovery?.triggered).toBe(true);
  });

  it('policy refusal stops with no micro detour (E and micro-only B)', () => {
    for (const force of [undefined, 'MICRO'] as const) {
      const t = task('config-v1'); const s = env(t);
      const rec = runAsg(s.spec, s.ws, s.agent, { ...s.opts, ...E, forceRoute: force });
      expect(rec).toMatchObject({ final_state: 'STOPPED', failure: { class: 'policy_refusal', recoverable: false }, actions: [] });
      expect(s.ws.read('package.json')).toBe(t.files['package.json']);
    }
  });

  it('untrusted skill content cannot widen permissions: an agent micro write outside the capability is refused and stops the run', () => {
    const t = task('money-v1'); const s = env(t);
    const evil: AgentPort = { ...s.agent, nextMicro: () => ({ tool: 'write_file', args: { path: 'src/cents.mjs', content: 'export function cents() { return 29; }\n' } }) };
    const rec = runAsg(s.spec, s.ws, evil, { ...s.opts, ...E });
    expect(rec.failure).toMatchObject({ class: 'permission_invalid', recoverable: false, first_failure_point: 'MICRO_RECOVERY' });
    expect(rec.gate_refusals).toBe(1);
    expect(s.ws.read('src/cents.mjs')).toBe(t.files['src/cents.mjs']);
  });

  it('no micro → macro return: a macro name in the micro phase is an invalid action and nothing executes it', () => {
    const t = task('money-v1'); const s = env(t);
    let n = 0;
    const agent: AgentPort = { ...s.agent, nextMicro: (...a) => (n++ === 0 ? { tool: 'asg:write_test_file_and_verify', args: {} } : s.agent.nextMicro(...a)) };
    const rec = runAsg(s.spec, s.ws, agent, { ...s.opts, ...E });
    expect(rec.actions.filter((a) => a.kind === 'invalid')).toHaveLength(1);
    expect(rec.actions.filter((a) => a.kind === 'macro').map((a) => a.name)).toEqual(['asg:inspect_target_module', 'asg:write_test_file_and_verify']); // only the plan's calls
    expect(rec.final_state).toBe('SUCCEEDED');
  });

  it('an unchanged declared write is not success even when the old (weak) test passes (timeout before any effect)', () => {
    const t = task('clamp-v2'); const s = env(t);
    const fault: FaultPlan = { kind: 'timeout_uncertain', timeoutAfterWrite: false };
    const rec = runAsg(s.spec, s.ws, s.agent, { ...s.opts, ...E, fault });
    expect(rec.incident).toBeNull(); // the verify-before-recovery check did not accept the untouched file
    expect(rec.recovery?.context?.applied).toBe('unknown');
    expect(rec.final_state).toBe('SUCCEEDED'); // recovered by micro
    expect(s.verdict().verified).toBe(true);
  });

  it('execution, verification and incident are separate fields', () => {
    const t = task('slug-v1'); const s = env(t);
    const rec = runAsg(s.spec, s.ws, s.agent, { ...s.opts, ...D, fault: { kind: 'timeout_uncertain', timeoutAfterWrite: true } });
    expect(rec.execution_status).toBe('stopped');
    expect(rec.verification_status).toBe('passed');
    expect(rec.failure?.class).toBe('timeout_uncertain');
  });
});
