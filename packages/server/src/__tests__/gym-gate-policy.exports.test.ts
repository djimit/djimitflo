import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import {
  CANONICALIZATION_VERSION,
  GATE_POLICY_ID,
  GATE_POLICY_VERSION,
  GYM_EVALUATOR_VERSION,
  TEST_ONLY_DIFF_MAX,
  gateConfig,
  gateConfigDigest,
  gatePolicyClaim,
  gatePolicyResult,
  policyKey,
  type GatePolicyInput,
} from '../services/gym-gate-policy';

const GATES: GatePolicyInput = { scripts: ['test:changed', 'lint', 'type-check'], timeout_ms: 300_000, diff_max_lines: 200 };
let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(schema);
  runMigrations(db);
});
afterEach(() => {
  db.close();
});
describe('policyKey', () => {
  it('joins the five identity fields in a fixed order with slashes', () => {
    const key = policyKey({
      policy_id: GATE_POLICY_ID,
      policy_version: GATE_POLICY_VERSION,
      canonicalization_version: CANONICALIZATION_VERSION,
      evaluator_version: GYM_EVALUATOR_VERSION,
      config_digest: 'a'.repeat(64),
    });
    expect(key).toBe(`${GATE_POLICY_ID}/${GATE_POLICY_VERSION}/${CANONICALIZATION_VERSION}/${GYM_EVALUATOR_VERSION}/` + 'a'.repeat(64));
  });
  it('omits implementation_sha from the key (it is build provenance, not policy)', () => {
    const base = { policy_id: 'p', policy_version: 'v1', canonicalization_version: 'c', evaluator_version: 'e', config_digest: 'd' };
    expect(policyKey(base)).not.toContain('/impl/');
    // A different digest yields a different key.
    expect(policyKey({ ...base, config_digest: 'other' })).not.toBe(policyKey(base));
  });
});
describe('gatePolicyClaim', () => {
  it('binds the current identity plus attempt fields and the gate config', () => {
    const claim = gatePolicyClaim(db, {
      gates: GATES,
      gated: true,
      attemptId: 'attempt-1',
      claimedAt: '2026-11-04T00:00:00.000Z',
      task: 'task-x',
      species: 'species-y',
    }, {});
    expect(claim.policy_id).toBe(GATE_POLICY_ID);
    expect(claim.policy_version).toBe(GATE_POLICY_VERSION);
    expect(claim.canonicalization_version).toBe(CANONICALIZATION_VERSION);
    expect(claim.evaluator_version).toBe(GYM_EVALUATOR_VERSION);
    expect(claim.config_digest).toBe(gateConfigDigest(GATES));
    expect(claim.attempt_id).toBe('attempt-1');
    expect(claim.claimed_at).toBe('2026-11-04T00:00:00.000Z');
    expect(claim.task).toBe('task-x');
    expect(claim.species).toBe('species-y');
    expect(claim.gated).toBe(true);
    expect(claim.implementation_sha).toBeNull();
  });
  it('records the gate config verbatim (checks order preserved, test-only diff max pinned)', () => {
    const claim = gatePolicyClaim(db, { gates: GATES, gated: false, attemptId: 'a', claimedAt: 't', task: 'x', species: 'y' }, {});
    expect(claim.config).toEqual(gateConfig(GATES));
    expect(claim.config.checks).toEqual(['test:changed', 'lint', 'type-check']);
    expect(claim.config.test_only_diff_max_lines).toBe(TEST_ONLY_DIFF_MAX);
  });
  it('omits holdout when no frozen holdout row matches the task', () => {
    const claim = gatePolicyClaim(db, { gates: GATES, gated: true, attemptId: 'a', claimedAt: 't', task: 'no-holdout-task', species: 'y' }, {});
    expect(claim.holdout).toBeUndefined();
  });
});
describe('gatePolicyResult', () => {
  it('returns undefined for an unbound (absent) claim — no retrospective binding', () => {
    expect(gatePolicyResult(undefined, '2026-11-04T00:00:00.000Z', { lint: 'pass' })).toBeUndefined();
  });
  it('returns undefined when the claim has no config_digest', () => {
    expect(gatePolicyResult({ policy_id: 'p' } as never, 't', undefined)).toBeUndefined();
  });
  it('projects only the identity fields plus result_at and normalises missing gate results to null', () => {
    const claim = gatePolicyClaim(db, { gates: GATES, gated: true, attemptId: 'a', claimedAt: 'c', task: 'x', species: 'y' }, {});
    const res = gatePolicyResult(claim, '2026-11-04T01:00:00.000Z', { lint: 'pass', type_check: 'fail' });
    expect(res).toEqual({
      policy_id: claim.policy_id,
      policy_version: claim.policy_version,
      config_digest: claim.config_digest,
      result_at: '2026-11-04T01:00:00.000Z',
      gate_results: { lint: 'pass', type_check: 'fail' },
    });
    expect(gatePolicyResult(claim, 'r', undefined)?.gate_results).toBeNull();
  });
});
