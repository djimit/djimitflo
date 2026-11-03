import type { Database } from 'better-sqlite3';
import { AUTH_MISSING, LIMIT_HIT, claudeSubscriptionBackoff, subscriptionAuthPresent, type SubscriptionLimitHit } from './subscription-gym';
import { ollamaLimited, panelFallbackRuntime } from './inference-failover';

/**
 * OLLAMA_OUTAGE_FALLBACK_RUNTIME (operator 18-10, incident ~14:00Z: Ollama Cloud weekly usage limit on every model; all
 * opencode makers timed out and every reviewer exited 1 → false regressions). Unset = off. 'claude' = every production lease
 * whose runtime would be opencode (maker, retry, evolve sibling, checker, security checker) runs on the claude executor on
 * the Claude Max subscription instead — the same subscription safety as the gym species (#881/#883): the task env carries
 * DJIMITFLO_SUBSCRIPTION_AUTH=claude, so the child env drops every API key / base URL, gets CLAUDE_CODE_OAUTH_TOKEN, and the
 * CLI runs with `--permission-mode acceptEdits` (never the blanket bypass). No token → the lease fails 'infra:
 * subscription_auth_missing' before any spawn; a usage-limit error → 'infra: subscription_limit' and, for
 * SUBSCRIPTION_GYM_LIMIT_BACKOFF_MS, every further fallback lease is refused the same way without a spawn.
 *
 * Decided once per lease, where the executor fixes the effective runtime (runMaker / executeChecker): the lease row becomes
 * runtime 'claude' with metadata.runtime_fallback = {from, to, reason, from_model?}; a bandit choice stays recorded on the
 * lease ($.bandit) but is overridden; the opencode model is dropped; an F2 checker arm becomes 'fallback_suspended'.
 * Experiment evidence (ACE-001, STE-001, MAKER-DEPS-001, X1, F2, memory holdout) excludes these leases and their goals.
 * Never the gym (its species are the point) or TG-001.
 */
export type FallbackRuntime = 'claude';
export const FALLBACK_REASON = 'ollama_outage';
/** Evidence ref on a fallback maker's skill outcome; experiment queries leave such outcomes out. */
export const FALLBACK_REF = `runtime_fallback:${FALLBACK_REASON}`;
export const F2_SUSPENDED_ARM = 'fallback_suspended';
/** tg-001.ts TG_LOOP (frozen surface; not imported so the evidence modules keep a leaf import — a test pins it equal). */
export const TG_LOOP_NAME = 'tg-001';

export const outageFallbackRuntime = (env: NodeJS.ProcessEnv = process.env): FallbackRuntime | null =>
  env.OLLAMA_OUTAGE_FALLBACK_RUNTIME?.trim().toLowerCase() === 'claude' ? 'claude' : null;
/** The manual flag, else OLLAMA_AUTO_FAILOVER=on with a recorded Ollama usage limit (inference-failover.ts), else null. */
export const effectiveFallbackRuntime = (db: Database | null | undefined, env: NodeJS.ProcessEnv = process.env): FallbackRuntime | null =>
  outageFallbackRuntime(env) ?? (ollamaLimited(db, env) ? 'claude' : null);

/** SQL: the skill outcome (alias) is not a fallback run. */
export const notFallbackOutcomeSql = (alias: string): string => `COALESCE(${alias}.evidence_refs_json, '') NOT LIKE '%"${FALLBACK_REF}"%'`;
/** SQL: no lease of the goal (expression) ran on the outage fallback. */
export const notFallbackGoalSql = (goalIdExpr: string): string => `NOT EXISTS (SELECT 1 FROM loop_runs fr JOIN worker_leases fl ON fl.loop_run_id = fr.id
  WHERE fr.goal_id = ${goalIdExpr} AND json_extract(fl.metadata, '$.runtime_fallback') IS NOT NULL)`;
/** SQL: no lease of the run (expression) ran on the outage fallback. */
export const notFallbackRunSql = (runIdExpr: string): string => `NOT EXISTS (SELECT 1 FROM worker_leases fl
  WHERE fl.loop_run_id = ${runIdExpr} AND json_extract(fl.metadata, '$.runtime_fallback') IS NOT NULL)`;

interface LeaseLike { id: string; role: string; runtime: string; metadata: Record<string, unknown> }
interface RunLike { id: string; loop_name: string }

/**
 * The effective runtime of a lease about to run. Off, a non-opencode runtime, the gym, TG-001 or a gym subscription species →
 * `runtime` unchanged and nothing written. Otherwise the lease row is rewritten to the fallback (idempotent) and the lease
 * object is updated in place.
 */
export function applyOutageFallback(db: Database, run: RunLike, lease: LeaseLike, runtime: string, env: NodeJS.ProcessEnv = process.env): string {
  const done = lease.metadata.runtime_fallback as { from?: unknown; to?: unknown } | undefined;
  if (done && typeof done === 'object' && typeof done.to === 'string') return runtime === done.from ? done.to : runtime; // a continuation keeps it
  const to = effectiveFallbackRuntime(db, env);
  if (!to || runtime !== 'opencode' || run.loop_name === 'evolution-gym' || run.loop_name === TG_LOOP_NAME || lease.metadata.subscription_auth) return runtime;
  const meta: Record<string, unknown> = { ...lease.metadata };
  const fallback: Record<string, unknown> = { from: runtime, to, reason: FALLBACK_REASON, at: new Date().toISOString(),
    ...(outageFallbackRuntime(env) ? {} : { trigger: 'auto' }) }; // auto: OLLAMA_AUTO_FAILOVER recorded the usage limit
  if (typeof meta.model === 'string') fallback.from_model = meta.model;
  if (typeof meta.checker_family_arm === 'string') fallback.from_checker_family_arm = meta.checker_family_arm;
  delete meta.model; // an opencode provider/model means nothing to claude
  if (meta.checker_family_arm !== undefined) meta.checker_family_arm = F2_SUSPENDED_ARM; // e.g. a randomised checker's retry
  meta.runtime_fallback = fallback;
  meta.subscription_auth = to; // the executor's subscription marker: keys stripped, OAuth token in, acceptEdits
  db.prepare('UPDATE worker_leases SET runtime = ?, metadata = ?, updated_at = ? WHERE id = ?').run(to, JSON.stringify(meta), new Date().toISOString(), lease.id);
  lease.runtime = to;
  lease.metadata = meta;
  return to;
}

export const isFallbackLease = (lease: { metadata: Record<string, unknown> }): boolean =>
  typeof lease.metadata.runtime_fallback === 'object' && lease.metadata.runtime_fallback !== null;

/** A fallback lease hit the subscription's usage limit within the back-off window. */
export function fallbackInLimitBackoff(db: Database, now = Date.now(), env: NodeJS.ProcessEnv = process.env): boolean {
  return claudeSubscriptionBackoff(db, now, env) !== null; // shared with the claude gym species and the panel fallback
}

/**
 * PANEL_FALLBACK_RUNTIME: the panel's inference status. 'inference_unavailable' = the fallback is needed (Ollama limited, or
 * the panel itself hit the subscription limit) while the shared Claude subscription backoff holds: seats wait (no attempt,
 * no quarantine, no verdict) until `backoff.until`. 'off' = flag off; 'available' otherwise.
 */
export function panelInferenceStatus(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()):
  { status: 'off' | 'available' | 'inference_unavailable'; backoff: SubscriptionLimitHit | null } {
  if (!panelFallbackRuntime(env)) return { status: 'off', backoff: null };
  const backoff = claudeSubscriptionBackoff(db, now, env);
  const needed = Boolean(backoff) && (effectiveFallbackRuntime(db, env) !== null || backoff!.source === 'panel_review');
  return { status: needed ? 'inference_unavailable' : 'available', backoff };
}

/** Why a fallback lease must not spawn (no OAuth token, or the subscription is benched), else null. */
export function fallbackRefusal(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()): string | null {
  if (!subscriptionAuthPresent('claude', env)) return AUTH_MISSING;
  if (fallbackInLimitBackoff(db, now, env)) return LIMIT_HIT;
  return null;
}

/** Evidence: fallback leases per role over the window, limit hits and auth refusals (null when the table is missing). */
export function outageFallbackEvidence(db: Database, since: string, env: NodeJS.ProcessEnv = process.env) {
  type Row = { role: string; n: number; limit_hits: number; auth_missing: number };
  let rows: Row[] | null = null;
  try {
    rows = db.prepare(`SELECT role, COUNT(*) AS n,
        COALESCE(SUM(json_extract(metadata, '$.subscription_limit_hit_at') IS NOT NULL), 0) AS limit_hits,
        COALESCE(SUM(json_extract(metadata, '$.failure_reason') = ?), 0) AS auth_missing
      FROM worker_leases WHERE json_extract(metadata, '$.runtime_fallback') IS NOT NULL AND created_at >= ? GROUP BY role`).all(AUTH_MISSING, since) as Row[];
  } catch { rows = null; }
  return { mode: outageFallbackRuntime(env) ?? 'off', in_backoff: fallbackInLimitBackoff(db, Date.now(), env), by_role: rows,
    note: 'OLLAMA_OUTAGE_FALLBACK_RUNTIME: opencode production leases run on claude (Max subscription, keys stripped, acceptEdits). Excluded from ACE-001/STE-001/MAKER-DEPS-001/X1/F2/memory-holdout evidence.' };
}
