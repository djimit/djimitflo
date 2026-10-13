import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';

/**
 * Gate-policy binding (operator follow-up to #819): every NON-TG gym attempt records, at claim and at result, which
 * production-gate policy judged it — gate_policy_id, an immutable sha256 over the canonical active gate configuration,
 * the evaluator version, attempt id, execution timestamps, holdout epoch (holdout tasks only), task + species identity and
 * the per-check gate results. TG-001 runs never get these fields (the TG experiment surface stays as frozen).
 * Historical attempts are never rewritten: a row without a claim binding reads as 'unrecorded' and never gets a hash.
 * GYM_REQUIRE_GATE_POLICY_HASH=true (default off) additionally requires a recorded, matching policy hash for eligibility;
 * off = no behaviour change.
 */
export const GATE_POLICY_ID = 'gym-prod-gates/v1';
/** Bump on any change to how the gym oracle / gate scoring judges an attempt (part of the policy hash). */
export const GYM_EVALUATOR_VERSION = 'gym-evaluator/2026-10-14.1';
/** The worker's raised diff limit for a test-only change (scripts/gym-worker.mjs). */
export const TEST_ONLY_DIFF_MAX = 400;
const GATE_STATUSES = ['fail', 'pass', 'skipped'];

export interface GatePolicyInput { scripts: string[]; timeout_ms: number; diff_max_lines: number }
export interface GatePolicyClaim { id: string; hash: string; evaluator_version: string; code_sha: string | null; attempt_id: string; claimed_at: string;
  task: string; species: string; gated: boolean; holdout?: { table: string; epoch: number } }
export interface GatePolicyResult { id: string; hash: string; result_at: string; gate_results: Record<string, string> | null }

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

/** The canonical active production-gate configuration the hash is taken over (check order is kept: the worker runs them in order). */
export function gatePolicyConfig(gates: GatePolicyInput) {
  return { policy_id: GATE_POLICY_ID, evaluator_version: GYM_EVALUATOR_VERSION, checks: [...gates.scripts], timeout_ms: gates.timeout_ms,
    diff_max_lines: gates.diff_max_lines, test_only_diff_max_lines: TEST_ONLY_DIFF_MAX, gate_statuses: GATE_STATUSES };
}
export const gatePolicyHash = (gates: GatePolicyInput): string => createHash('sha256').update(canonicalGateJson(gatePolicyConfig(gates))).digest('hex');

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
  return { id: GATE_POLICY_ID, hash: gatePolicyHash(o.gates), evaluator_version: GYM_EVALUATOR_VERSION,
    code_sha: env.DJIMITFLO_BUILD_COMMIT && env.DJIMITFLO_BUILD_COMMIT !== 'unknown' ? env.DJIMITFLO_BUILD_COMMIT : env.DJIMITFLO_COMMIT_SHA || null,
    attempt_id: o.attemptId, claimed_at: o.claimedAt, task: o.task, species: o.species, gated: o.gated, ...(holdout ? { holdout } : {}) };
}

/** Result side: only for an attempt whose claim was bound (no retrospective hash for a run claimed before the binding existed). */
export function gatePolicyResult(claim: GatePolicyClaim | undefined, resultAt: string, gateResults: Record<string, string> | undefined): GatePolicyResult | undefined {
  if (!claim?.hash) return undefined;
  return { id: claim.id, hash: claim.hash, result_at: resultAt, gate_results: gateResults ?? null };
}

/** Reader: the binding of one attempt's loop_runs.metadata, or 'unrecorded' (historical / TG rows). */
export function attemptGatePolicy(metadata: string | null | undefined): { status: 'recorded'; claim: GatePolicyClaim; result: GatePolicyResult | null } | { status: 'unrecorded' } {
  try {
    const m = JSON.parse(metadata ?? '{}') as { gym?: { gate_policy?: GatePolicyClaim }; gym_result?: { gate_policy?: GatePolicyResult } };
    if (m.gym?.gate_policy?.hash) return { status: 'recorded', claim: m.gym.gate_policy, result: m.gym_result?.gate_policy ?? null };
  } catch { /* unreadable metadata = unrecorded */ }
  return { status: 'unrecorded' };
}

/**
 * Optional eligibility clause for gated-evidence readers over loop_runs: '' while GYM_REQUIRE_GATE_POLICY_HASH is off (no
 * behaviour change); when on, the attempt must carry the CURRENT policy hash on both claim and result. The hash is hex we
 * computed, so it is safe to inline.
 */
export function gatePolicyClause(gates: GatePolicyInput, env: NodeJS.ProcessEnv = process.env, alias = ''): string {
  if (!requireGatePolicyHash(env)) return '';
  const h = gatePolicyHash(gates); const m = `${alias ? `${alias}.` : ''}metadata`;
  return ` AND json_extract(${m}, '$.gym.gate_policy.hash') = '${h}' AND json_extract(${m}, '$.gym_result.gate_policy.hash') = '${h}'`;
}
