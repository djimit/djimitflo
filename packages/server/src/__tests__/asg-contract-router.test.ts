import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  admitApplicabilityRule, contractDigest, ContractRegistry, effectiveWrites, globToRegExp, isRecoverable, promote, recoveryKnowledge, validateSchema,
  type AdmissionEvidence, type MacroContract,
} from '../services/asg/contract';
import { CapabilityGate, FsWorkspace } from '../services/asg/effects';
import { ASG_MACROS, defaultRegistry, REPLACE_IN_TEST_AND_VERIFY, WRITE_TEST_FILE_AND_VERIFY } from '../services/asg/macros';
import { decideRoute, extractFeatures, FEATURE_SCHEMA, POLICY_HASH, POLICY_RULES, type AsgTaskSpec } from '../services/asg/router';
import { asgEffectiveMode, asgMode } from '../services/asg/mode';
import { fixtureTasks } from '../services/asg/harness/fixtures';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });
const tmpWs = (files: Record<string, string>) => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'asg-cr-')); roots.push(r); const ws = new FsWorkspace(r); for (const [p, c] of Object.entries(files)) ws.write(p, c); return ws; };
const HARNESS = ['candidate', 'replay_validated', 'heldout_validated', 'shadow', 'eligible', 'active'] as const;
const ev = (gate: AdmissionEvidence['gate'], kind: AdmissionEvidence['kind'], extra: Partial<AdmissionEvidence> = {}): AdmissionEvidence => ({ gate, kind, ref: 'r', runs: 5, verified: 5, invariant_violations: 0, at: '2026-10-24T00:00:00Z', ...extra });

describe('ASG_MODE', () => {
  it('off unless shadow/on; on refuses to act while an oracle-population experiment is on', () => {
    expect(asgMode({})).toBe('off'); expect(asgMode({ ASG_MODE: 'true' })).toBe('off'); expect(asgMode({ ASG_MODE: ' Shadow ' })).toBe('shadow');
    expect(asgEffectiveMode({ ASG_MODE: 'on' })).toEqual({ requested: 'on', mode: 'on', blocked_by: [] });
    expect(asgEffectiveMode({ ASG_MODE: 'on', MAKER_DEPS_001_MODE: 'on', EFFORT_SIBLING_RANDOMISE: 'true' })).toEqual({ requested: 'on', mode: 'shadow', blocked_by: ['MAKER_DEPS_001_MODE', 'EFFORT_SIBLING_RANDOMISE'] });
    expect(asgEffectiveMode({ ASG_MODE: 'shadow', ACE_001_MODE: 'on' })).toEqual({ requested: 'shadow', mode: 'shadow', blocked_by: [] });
  });
});

describe('ASG macro contracts', () => {
  it('three macros, none of them publish/deploy/merge/install, each with every contract field', () => {
    expect(ASG_MACROS.map((c) => c.skill_id)).toEqual(['asg:inspect_target_module', 'asg:write_test_file_and_verify', 'asg:replace_in_test_and_verify']);
    for (const c of ASG_MACROS) {
      expect(JSON.stringify(c)).not.toMatch(/\b(publish|deploy|merge|push|npm (ci|install))\b/i);
      for (const k of ['skill_id', 'version', 'input_schema', 'output_schema', 'preconditions', 'effects', 'required_capabilities', 'runtime_compat', 'postconditions', 'verifier_ref', 'timeout_ms', 'budget_units', 'failure_taxonomy', 'idempotency', 'micro_fallback', 'lineage'] as const) expect(c[k], `${c.skill_id}.${k}`).toBeDefined();
      expect(contractDigest(c)).toMatch(/^[0-9a-f]{64}$/);
      expect(c.runtime_compat).toEqual(['asg-harness']);
    }
  });

  it('an immutable version: re-registering a changed contract under the same version is refused', () => {
    const r = defaultRegistry();
    const widened: MacroContract = { ...WRITE_TEST_FILE_AND_VERIFY, effects: { ...WRITE_TEST_FILE_AND_VERIFY.effects, write: ['**'] } };
    expect(() => r.register(widened)).toThrow(/ASG_CONTRACT_VERSION_IMMUTABLE/);
    expect(r.get('asg:write_test_file_and_verify')!.contract.effects.write).toEqual(['${test_path}']);
  });

  it('untrusted contract content cannot widen permissions: effects are intersected with the task capability, and the gate refuses at dispatch', () => {
    const widened: MacroContract = { ...WRITE_TEST_FILE_AND_VERIFY, skill_id: 'evil', effects: { read: [], write: ['**', 'package.json', '${test_path}'], exec: [] } };
    expect(effectiveWrites(widened, { test_path: 'test/a.test.mjs' }, ['test/**'])).toEqual({ allowed: ['test/a.test.mjs'], refused: ['**', 'package.json'] });
    // a traversal value never resolves; a glob never counts as a concrete write
    expect(effectiveWrites(widened, { test_path: '../escape.test.mjs' }, ['test/**'])).toEqual({ allowed: [], refused: ['**', 'package.json', '${test_path}'] });
    const gate = new CapabilityGate(['test/a.test.mjs']);
    expect(() => gate.checkWrite('package.json')).toThrow(/capability boundary/);
    expect(() => gate.checkWrite('.git/config')).toThrow();
    expect(() => gate.checkWrite('test/a.test.mjs')).not.toThrow();
  });

  it('schema validation is strict (missing, extra, pattern)', () => {
    const s = WRITE_TEST_FILE_AND_VERIFY.input_schema;
    expect(validateSchema(s, { test_path: 'test/a.test.mjs', source_path: 'src/a.mjs', content: 'x' })).toBeNull();
    expect(validateSchema(s, { test_path: 'test/a.test.mjs', source_path: 'src/a.mjs' })).toBe('missing content');
    expect(validateSchema(s, { test_path: 'test/a.test.mjs', source_path: 'src/a.mjs', content: 'x', extra: 1 })).toBe('unexpected field extra');
    expect(validateSchema(s, { test_path: 'package.json', source_path: 'src/a.mjs', content: 'x' })).toBe('test_path does not match');
  });

  it('recovery knowledge is separate and never marks policy/permission/external-effect classes recoverable', () => {
    const k = recoveryKnowledge(REPLACE_IN_TEST_AND_VERIFY);
    expect(k.recoverable).toEqual(['executor_exception', 'partial_effect', 'precondition_mismatch', 'timeout_uncertain', 'tool_schema', 'validation_failure']);
    for (const cls of ['policy_refusal', 'permission_invalid', 'unknown_external_effect', 'concurrent_execution', 'lease_lost'] as const) expect(isRecoverable(REPLACE_IN_TEST_AND_VERIFY, cls)).toBe(false);
  });

  it('globs: * stays in one segment, ** spans segments', () => {
    expect(globToRegExp('test/*.mjs').test('test/a.mjs')).toBe(true);
    expect(globToRegExp('test/*.mjs').test('test/x/a.mjs')).toBe(false);
    expect(globToRegExp('test/**').test('test/x/a.mjs')).toBe(true);
  });
});

describe('ASG lifecycle: promotion is blocked without evaluation evidence', () => {
  const m = () => new ContractRegistry().register(WRITE_TEST_FILE_AND_VERIFY);
  it('candidate needs train-split replay evidence; no evidence, wrong kind, wrong split, too few, violations or unverified runs are refused', () => {
    expect(promote(m(), 'replay_validated', null)).toEqual({ ok: false, reason: 'ASG_PROMOTION_NO_EVIDENCE' });
    expect(promote(m(), 'replay_validated', ev('replay_validated', 'heldout', { split: 'train' }))).toMatchObject({ ok: false });
    expect(promote(m(), 'replay_validated', ev('replay_validated', 'replay', { split: 'test' }))).toMatchObject({ ok: false, reason: 'ASG_PROMOTION_WRONG_SPLIT: need train' });
    expect(promote(m(), 'replay_validated', ev('replay_validated', 'replay', { split: 'train', runs: 4, verified: 4 }))).toMatchObject({ ok: false });
    expect(promote(m(), 'replay_validated', ev('replay_validated', 'replay', { split: 'train', invariant_violations: 1 }))).toMatchObject({ ok: false, reason: 'ASG_PROMOTION_INVARIANT_VIOLATIONS' });
    expect(promote(m(), 'replay_validated', ev('replay_validated', 'replay', { split: 'train', verified: 4 }))).toMatchObject({ ok: false });
    expect(promote(m(), 'replay_validated', ev('replay_validated', 'replay', { split: 'train' }))).toMatchObject({ ok: true, macro: { state: 'replay_validated' } });
  });
  it('no state can be skipped; active needs an operator decision; deprecated is always reachable', () => {
    expect(promote(m(), 'active', ev('active', 'operator'))).toMatchObject({ ok: false, reason: 'ASG_PROMOTION_NOT_NEXT: candidate → active' });
    expect(promote(m(), 'eligible', ev('eligible', 'shadow', { runs: 20, verified: 20 }))).toMatchObject({ ok: false });
    expect(promote(m(), 'deprecated', null)).toMatchObject({ ok: true, macro: { state: 'deprecated' } });
  });
  it('learned applicability rules need train-split provenance', () => {
    expect(admitApplicabilityRule({ id: 'r', skill_id: 's', version: 1, condition: {}, provenance: { derived_from_runs: [], split: 'train', created_by: 'x', created_at: 't' } })).toEqual({ ok: false, reason: 'ASG_RULE_PROVENANCE_REQUIRED' });
    expect(admitApplicabilityRule({ id: 'r', skill_id: 's', version: 1, condition: {}, provenance: { derived_from_runs: ['run1'], split: 'train', created_by: 'x', created_at: 't' } })).toEqual({ ok: true });
  });
  it('the production router never executes a candidate contract (only eligible/active)', () => {
    const t = fixtureTasks().find((x) => x.spec.task_id === 'slug-v1')!;
    const spec: AsgTaskSpec = { ...t.spec, runtime: 'asg-harness', runtime_has_macro_adapter: true };
    const ws = tmpWs(t.files);
    const d = decideRoute(spec, extractFeatures(spec, ws), defaultRegistry(), { executableStates: ['eligible', 'active'], remainingBudget: 99 });
    expect(d.route).toBe('MICRO');
    expect(d.alternatives).toEqual([{ route: 'HYBRID', skill: 'asg:write_test_file_and_verify', reason: 'LIFECYCLE_NOT_EXECUTABLE:candidate' }]);
  });
});

describe('ASG router: deterministic, decision-time features only', () => {
  const tasks = fixtureTasks();
  const routeOf = (id: string, over: Partial<AsgTaskSpec> = {}, files?: Record<string, string>) => {
    const t = tasks.find((x) => x.spec.task_id === id)!;
    const spec: AsgTaskSpec = { ...t.spec, runtime: 'asg-harness', runtime_has_macro_adapter: true, ...over };
    const ws = tmpWs({ ...t.files, ...(t.userEdits ?? {}), ...(files ?? {}) });
    return decideRoute(spec, extractFeatures(spec, ws), defaultRegistry(), { executableStates: HARNESS, remainingBudget: 12 });
  };
  it('records policy hash, feature schema, features, skill version + digest, reasons and alternatives', () => {
    const d = routeOf('slug-v1');
    expect(d).toMatchObject({ route: 'HYBRID', reason_codes: ['MACRO_WITH_RECOVERY'], policy: { id: 'asg-policy', version: 1, hash: POLICY_HASH } });
    expect(Object.keys(d.features).sort()).toEqual(Object.keys(FEATURE_SCHEMA).sort());
    expect(d.skill).toEqual({ skill_id: 'asg:write_test_file_and_verify', version: 1, digest: contractDigest(WRITE_TEST_FILE_AND_VERIFY), state: 'candidate' });
    expect(d.prefix?.skill_id).toBe('asg:inspect_target_module');
    expect(d.alternatives).toEqual([{ route: 'MICRO', skill: null, reason: 'always admissible within the same permissions' }]);
  });
  it('the policy hash is pinned to the rule text (a rule change must bump the version)', () => {
    expect(POLICY_RULES).toHaveLength(7);
    expect(POLICY_HASH).toBe('04ca63d0770d6532');
  });
  it('policy refusal → STOP; no macro adapter → MICRO; several targets → MICRO; contract mismatch → MICRO', () => {
    expect(routeOf('config-v1').route).toBe('STOP');
    expect(routeOf('slug-v1', { runtime: 'opencode', runtime_has_macro_adapter: false })).toMatchObject({ route: 'MICRO', reason_codes: ['RUNTIME_NO_MACRO_ADAPTER'] });
    expect(routeOf('pair-v1')).toMatchObject({ route: 'MICRO', reason_codes: ['MULTI_TARGET'] });
    expect(routeOf('slug-v1', {}, { 'test/slug.test.mjs': 'exists' })).toMatchObject({ route: 'MICRO', reason_codes: ['NO_CONTRACT_MATCH'] });
    expect(routeOf('clamp-v1', { capability: { write: ['other/**'] }, declared_writes: ['test/clamp.test.mjs'] }).route).toBe('STOP');
  });
  it('no leakage: the hidden oracle (mutant, must-keep, solution, macro plan) and other runs cannot change the decision', () => {
    for (const t of tasks) {
      const a = routeOf(t.spec.task_id);
      const b = routeOf(t.spec.task_id); // pure: same inputs, same decision
      expect(b).toEqual(a);
      const spec = { ...t.spec, runtime: 'asg-harness', runtime_has_macro_adapter: true } as Record<string, unknown>;
      for (const hidden of ['mutant', 'mustKeep', 'solution', 'macroPlan', 'verified', 'oracle']) expect(spec[hidden], hidden).toBeUndefined();
    }
  });
});
