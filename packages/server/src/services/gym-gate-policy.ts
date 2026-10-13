import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';

/**
 * Gate-policy binding (operator follow-up to #819): every NON-TG gym attempt records, at claim and at result, the identity
 * of the production-gate policy that judged it, plus attempt id, execution timestamps, holdout epoch (holdout tasks only),
 * task + species identity and the per-check gate results. TG-001 runs never get these fields (the TG experiment surface
 * stays as frozen). Historical attempts are never rewritten: a row without a claim binding is UNRECORDED and never gets one.
 *
 * A config digest alone is NOT complete execution provenance — the identity tuple is:
 *   { policy_id, policy_version, config_digest, canonicalization_version, evaluator_version, implementation_sha }
 * config_digest = sha256 of the canonical gate config under canonicalization_version (the serialization algorithm id);
 * the config itself is recorded next to it so the digest can be re-verified (gatePolicyClass -> INVALID_PROVENANCE).
 * GYM_REQUIRE_GATE_POLICY_HASH=true (default off) additionally requires the current identity for gated-evidence readers;
 * off = no behaviour change. gatePolicyClass is not wired into Gate A eligibility (that follows #819 + #822).
 */
export const GATE_POLICY_ID = 'gym-prod-gates';
/** Bump on a deliberate change to what the policy means (separate from the id and from the config digest). */
export const GATE_POLICY_VERSION = 'v1';
/** The serialization algorithm config_digest is taken under: recursively sorted keys, arrays in order, JSON.stringify. */
export const CANONICALIZATION_VERSION = 'canon/v1';
/** Bump on any change to how the gym oracle / gate scoring judges an attempt. */
export const GYM_EVALUATOR_VERSION = 'gym-evaluator/2026-10-14.1';
/** The worker's raised diff limit for a test-only change (scripts/gym-worker.mjs). */
export const TEST_ONLY_DIFF_MAX = 400;
const GATE_STATUSES = ['fail', 'pass', 'skipped'];

export interface GatePolicyInput { scripts: string[]; timeout_ms: number; diff_max_lines: number }
export interface PolicyIdentity { policy_id: string; policy_version: string; config_digest: string; canonicalization_version: string; evaluator_version: string; implementation_sha: string | null }
export interface GatePolicyClaim extends PolicyIdentity { config: ReturnType<typeof gateConfig>; attempt_id: string; claimed_at: string; task: string; species: string; gated: boolean;
  holdout?: { table: string; epoch: number } }
export interface GatePolicyResult { policy_id: string; policy_version: string; config_digest: string; result_at: string; gate_results: Record<string, string> | null }
export type GatePolicyClass = 'CURRENT_POLICY' | 'STALE_POLICY' | 'UNRECORDED' | 'INVALID_PROVENANCE';

/**
 * The active production-gate input, as remote-gym-service prodGatesConfig computes it. Duplicated (not imported) because
 * remote-gym-service → loop-daemon → loop-service cycles back into evolution-evidence; a test pins it equal to
 * prodGatesConfig for several envs, so the two cannot drift.
 */
export function activeGatePolicyInput(env: NodeJS.ProcessEnv = process.env): GatePolicyInput {
  const scripts = (env.LOOP_DAEMON_CHECK_SCRIPTS || '').split(',').map((v) => v.trim()).filter(Boolean);
  const timeout = Number(env.LOOP_DAEMON_CHECK_TIMEOUT_MS);
  return { scripts: (scripts.length ? scripts : ['test:changed', 'lint', 'type-check']).filter((s) => /^[\w:.-]{1,40}$/.test(s)).slice(0, 8),
    timeout_ms: Number.isFinite(timeout) && timeout >= 1000 ? Math.min(timeout, 600_000) : 120_000, diff_max_lines: 200 };
}
export const requireGatePolicyHash = (env: NodeJS.ProcessEnv = process.env): boolean => env.GYM_REQUIRE_GATE_POLICY_HASH === 'true';

const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;
export const canonicalGateJson = (v: unknown): string => JSON.stringify(canonical(v));
const CANONICALIZERS: Record<string, (v: unknown) => string> = { [CANONICALIZATION_VERSION]: canonicalGateJson };
const digestOf = (config: unknown, canon: string): string | null => CANONICALIZERS[canon] ? createHash('sha256').update(CANONICALIZERS[canon](config)).digest('hex') : null;

/** The canonical active production-gate configuration (check order is kept: the worker runs them in order). */
export function gateConfig(gates: GatePolicyInput) {
  return { checks: [...gates.scripts], timeout_ms: gates.timeout_ms, diff_max_lines: gates.diff_max_lines, test_only_diff_max_lines: TEST_ONLY_DIFF_MAX, gate_statuses: GATE_STATUSES };
}
export const gateConfigDigest = (gates: GatePolicyInput): string => digestOf(gateConfig(gates), CANONICALIZATION_VERSION)!;
const implementationSha = (env: NodeJS.ProcessEnv): string | null =>
  env.DJIMITFLO_BUILD_COMMIT && env.DJIMITFLO_BUILD_COMMIT !== 'unknown' ? env.DJIMITFLO_BUILD_COMMIT : env.DJIMITFLO_COMMIT_SHA || null;
export function currentPolicyIdentity(gates: GatePolicyInput, env: NodeJS.ProcessEnv = process.env): PolicyIdentity {
  return { policy_id: GATE_POLICY_ID, policy_version: GATE_POLICY_VERSION, config_digest: gateConfigDigest(gates), canonicalization_version: CANONICALIZATION_VERSION,
    evaluator_version: GYM_EVALUATOR_VERSION, implementation_sha: implementationSha(env) };
}
/** The policy part of the tuple as one key (implementation_sha is provenance of the build, not of the policy). */
export const policyKey = (i: Pick<PolicyIdentity, 'policy_id' | 'policy_version' | 'canonicalization_version' | 'evaluator_version' | 'config_digest'>): string =>
  `${i.policy_id}/${i.policy_version}/${i.canonicalization_version}/${i.evaluator_version}/${i.config_digest}`;

/** The frozen holdout (table, epoch) a task belongs to, if any. */
export function holdoutEpochOf(db: Database, task: string): { table: string; epoch: number } | undefined {
  for (const [table, col] of [['gym_holdout', 'commit_sha'], ['gym_mutant_holdout', 'key'], ['gym_write_test_holdout', 'key']]) {
    try {
      const r = db.prepare(`SELECT epoch FROM ${table} WHERE ${col} = ?`).get(task) as { epoch: number | null } | undefined;
      if (r) return { table, epoch: Number(r.epoch ?? 0) };
    } catch { /* table/column absent on an old schema */ }
  }
  return undefined;
}

export function gatePolicyClaim(db: Database, o: { gates: GatePolicyInput; gated: boolean; attemptId: string; claimedAt: string; task: string; species: string },
  env: NodeJS.ProcessEnv = process.env): GatePolicyClaim {
  const holdout = holdoutEpochOf(db, o.task);
  return { ...currentPolicyIdentity(o.gates, env), config: gateConfig(o.gates),
    attempt_id: o.attemptId, claimed_at: o.claimedAt, task: o.task, species: o.species, gated: o.gated, ...(holdout ? { holdout } : {}) };
}

/** Result side: only for an attempt whose claim was bound (no retrospective binding for a run claimed before it existed). */
export function gatePolicyResult(claim: GatePolicyClaim | undefined, resultAt: string, gateResults: Record<string, string> | undefined): GatePolicyResult | undefined {
  if (!claim || typeof claim !== 'object' || !claim.config_digest) return undefined;
  return { policy_id: claim.policy_id, policy_version: claim.policy_version, config_digest: claim.config_digest, result_at: resultAt, gate_results: gateResults ?? null };
}

/** Reader: the raw binding of one attempt's loop_runs.metadata, or 'unrecorded' (historical / TG rows). Not validated: see gatePolicyClass. */
export function attemptGatePolicy(metadata: string | null | undefined): { status: 'recorded'; claim: unknown; result: unknown } | { status: 'unrecorded' } {
  try {
    const m = JSON.parse(metadata ?? '{}') as { gym?: { gate_policy?: unknown }; gym_result?: { gate_policy?: unknown } };
    if (m.gym?.gate_policy != null) return { status: 'recorded', claim: m.gym.gate_policy, result: m.gym_result?.gate_policy ?? null };
  } catch { /* unreadable metadata = unrecorded */ }
  return { status: 'unrecorded' };
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
/**
 * Pure classifier of one attempt's binding against the current identity. INVALID_PROVENANCE = a malformed or partial tuple,
 * an unknown canonicalization, a config_digest that does not match its own recorded config, or a result bound to another
 * policy than its claim. STALE_POLICY = a self-consistent tuple whose policy differs (id, version, canonicalization,
 * evaluator or config digest). implementation_sha must be present (string or null) but is not compared: it changes every
 * deploy and is provenance of the build, not policy identity. Not wired into Gate A eligibility yet (after #819 + #822).
 */
export function gatePolicyClass(attempt: { claim?: unknown; result?: unknown } | null | undefined, current: PolicyIdentity): GatePolicyClass {
  const c = attempt?.claim;
  if (c == null) return 'UNRECORDED';
  if (typeof c !== 'object' || Array.isArray(c)) return 'INVALID_PROVENANCE';
  const t = c as Record<string, unknown>;
  if (![t.policy_id, t.policy_version, t.canonicalization_version, t.evaluator_version].every(str)) return 'INVALID_PROVENANCE';
  if (!str(t.config_digest) || !/^[0-9a-f]{64}$/.test(t.config_digest)) return 'INVALID_PROVENANCE';
  if (!('implementation_sha' in t) || (t.implementation_sha !== null && !str(t.implementation_sha))) return 'INVALID_PROVENANCE';
  if (!t.config || typeof t.config !== 'object' || digestOf(t.config, t.canonicalization_version as string) !== t.config_digest) return 'INVALID_PROVENANCE';
  const r = attempt?.result;
  if (r != null) {
    if (typeof r !== 'object' || Array.isArray(r)) return 'INVALID_PROVENANCE';
    const res = r as Record<string, unknown>;
    if (res.config_digest !== t.config_digest || res.policy_id !== t.policy_id || res.policy_version !== t.policy_version) return 'INVALID_PROVENANCE';
  }
  return policyKey(t as unknown as PolicyIdentity) === policyKey(current) ? 'CURRENT_POLICY' : 'STALE_POLICY';
}

/**
 * Optional eligibility clause for gated-evidence readers over loop_runs: '' while GYM_REQUIRE_GATE_POLICY_HASH is off (no
 * behaviour change); when on, the claim must carry the CURRENT policy tuple and the result the same digest. SQL cannot
 * re-verify the digest against the recorded config (gatePolicyClass does). All inlined values are our own constants/hex.
 */
export function gatePolicyClause(gates: GatePolicyInput, env: NodeJS.ProcessEnv = process.env, alias = ''): string {
  if (!requireGatePolicyHash(env)) return '';
  const i = currentPolicyIdentity(gates, env); const m = `${alias ? `${alias}.` : ''}metadata`;
  const eq = (path: string, v: string) => ` AND json_extract(${m}, '${path}') = '${v}'`;
  return eq('$.gym.gate_policy.policy_id', i.policy_id) + eq('$.gym.gate_policy.policy_version', i.policy_version)
    + eq('$.gym.gate_policy.canonicalization_version', i.canonicalization_version) + eq('$.gym.gate_policy.evaluator_version', i.evaluator_version)
    + eq('$.gym.gate_policy.config_digest', i.config_digest) + eq('$.gym_result.gate_policy.config_digest', i.config_digest);
}
