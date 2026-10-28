import { expect, it } from 'vitest';
import { OPERATOR_CONTRACTS, type OperatorContract, type ContractKeys } from './operator';

const EXPECTED: Record<string, string[]> = {
  cockpit: ['at', 'build', 'scorecard', 'guardrails', 'stalls', 'gym', 'remote_workers', 'maker_usage_7d', 'judgments_7d', 'needs_you', 'schedulers', 'genomes', 'deploys'],
  evolutionEvidence: ['at', 'window_days', 'flags', 'outcomes', 'outcomes_tagged', 'merge', 'drafts', 'genomes', 'gym', 'trials', 'models', 'oracle', 'commons',
    'forecasts_v2', 'hacks', 'estimates', 'ope', 'egress', 'failure_tasks', 'embedding_dim_mismatch', 'freshness', 'gates'],
  forecastsV2: ['forecasters', 'would_have_stopped'],
  runtimes: ['runtimes'],
  runtimeRow: ['runtime', 'admission', 'version', 'probe', 'leases_30d', 'leases_90d', 'last_success_at', 'gym', 'readiness'],
  digest: ['at', 'text', 'data'],
  draftPrs: ['total', 'unsettled', 'rows'],
  draftPrRow: ['run_id', 'lane', 'pr_url', 'pr_number', 'age_days', 'outcome', 'survived'],
  schedulers: ['armed', 'off', 'schedulers'],
};

it('OPERATOR_CONTRACTS exposes every expected contract with the documented keys', () => {
  const contracts = Object.keys(EXPECTED) as OperatorContract[];
  for (const name of contracts) {
    expect(OPERATOR_CONTRACTS[name]).toEqual(EXPECTED[name]);
  }
});

it('OPERATOR_CONTRACTS contains only the documented contracts', () => {
  expect(Object.keys(OPERATOR_CONTRACTS).sort()).toEqual(Object.keys(EXPECTED).sort());
});

it('every contract key list is a non-empty array of unique strings', () => {
  for (const [name, keys] of Object.entries(OPERATOR_CONTRACTS)) {
    expect(Array.isArray(keys), `${name} should be an array`).toBe(true);
    expect(keys.length, `${name} should be non-empty`).toBeGreaterThan(0);
    expect(new Set(keys).size, `${name} keys should be unique`).toBe(keys.length);
    for (const key of keys) {
      expect(typeof key, `${name} key should be a string`).toBe('string');
      expect(key.length, `${name} key should be non-empty`).toBeGreaterThan(0);
    }
  }
});

it('OperatorContract covers every key of OPERATOR_CONTRACTS', () => {
  const names = Object.keys(OPERATOR_CONTRACTS);
  // If the type drifted, assigning each name would still succeed at runtime; assert via a compile-time sample.
  const sample: OperatorContract = 'cockpit';
  expect(names).toContain(sample);
  expect(names.length).toBe(Object.keys(EXPECTED).length);
});

it('ContractKeys resolves to the tuple element type of the matching contract', () => {
  // Compile-time check: ContractKeys<'runtimes'> must be 'runtimes'.
  const single: ContractKeys<'runtimes'> = 'runtimes';
  expect(single).toBe('runtimes');
  // ContractKeys<'digest'> must be one of 'at' | 'text' | 'data'.
  const digestKey: ContractKeys<'digest'> = 'text';
  expect(['at', 'text', 'data']).toContain(digestKey);
});

it('runtimes and schedulers contracts expose their list-bearing keys', () => {
  expect(OPERATOR_CONTRACTS.runtimes).toEqual(['runtimes']);
  expect(OPERATOR_CONTRACTS.schedulers).toEqual(['armed', 'off', 'schedulers']);
});

it('runtimeRow and draftPrRow contracts describe row shapes distinct from their parent lists', () => {
  expect(OPERATOR_CONTRACTS.runtimeRow).toContain('runtime');
  expect(OPERATOR_CONTRACTS.runtimeRow).toContain('readiness');
  expect(OPERATOR_CONTRACTS.draftPrRow).toContain('pr_url');
  expect(OPERATOR_CONTRACTS.draftPrRow).toContain('survived');
});

it('evolutionEvidence is the largest contract and includes freshness/gates', () => {
  const sizes = Object.values(OPERATOR_CONTRACTS).map((k) => k.length);
  expect(OPERATOR_CONTRACTS.evolutionEvidence.length).toBe(Math.max(...sizes));
  expect(OPERATOR_CONTRACTS.evolutionEvidence).toContain('freshness');
  expect(OPERATOR_CONTRACTS.evolutionEvidence).toContain('gates');
});

it('forecastsV2 exposes exactly the forecasters and would_have_stopped keys', () => {
  expect(OPERATOR_CONTRACTS.forecastsV2).toEqual(['forecasters', 'would_have_stopped']);
});

it('digest is the minimal three-key response shape', () => {
  expect(OPERATOR_CONTRACTS.digest).toEqual(['at', 'text', 'data']);
  expect(OPERATOR_CONTRACTS.digest.length).toBe(3);
});