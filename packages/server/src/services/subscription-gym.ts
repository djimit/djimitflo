import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { wilson } from './evolution-estimators';
export { SUBSCRIPTION_ENV_MARKER, isBillingKey, subscriptionChildEnv } from '../execution/executors/subscription-env';

/**
 * Subscription CLI gym species (operator 2026-10-17): Claude Code on the Anthropic Max subscription (OAuth,
 * CLAUDE_CODE_OAUTH_TOKEN) and Codex CLI on the ChatGPT Pro subscription (login state in $CODEX_HOME/auth.json, default
 * ~/.codex/auth.json) compete as makers in the LOCAL gym only — never on production goals, never in the bandit (they write
 * skill_outcomes domain 'gym' under `loop-maker:gym:<runtime>`; the bandit reads `loop-maker:<loop>:<runtime>`).
 *
 * SUBSCRIPTION_GYM_SPECIES='' (default, off) | 'claude' | 'codex' | 'claude,codex' runs those species in the local gym even
 * while EVOLUTION_GYM_ENABLED is false (the other species stay off then). SUBSCRIPTION_GYM_MAX_PER_DAY (default 5) caps
 * attempts per species per 24 h, discards included (each one may have spent subscription quota).
 *
 * Flat-rate subscriptions must never fall back to API-key billing: the child env of these makers drops every API key the
 * CLI could bill against (subscriptionChildEnv), and an attempt without the subscription login is refused before any spawn
 * ('infra: subscription_auth_missing'). A rate/usage-limit error from the CLI is 'infra: subscription_limit' (no species
 * penalty) and benches the species for SUBSCRIPTION_GYM_LIMIT_BACKOFF_MS (default 5 h, one subscription window).
 * The OAuth token is read from the server env at spawn time only: never persisted, never logged.
 */
export type SubscriptionRuntime = 'claude' | 'codex';
const RUNTIMES: SubscriptionRuntime[] = ['claude', 'codex'];

export function subscriptionGymSpecies(env: NodeJS.ProcessEnv = process.env): SubscriptionRuntime[] {
  const want = (env.SUBSCRIPTION_GYM_SPECIES || '').split(',').map((s) => s.trim().toLowerCase());
  return RUNTIMES.filter((r) => want.includes(r));
}
export const subscriptionGymMaxPerDay = (env: NodeJS.ProcessEnv = process.env): number => Number(env.SUBSCRIPTION_GYM_MAX_PER_DAY) || 5;
export const subscriptionLimitBackoffMs = (env: NodeJS.ProcessEnv = process.env): number => Number(env.SUBSCRIPTION_GYM_LIMIT_BACKOFF_MS) || 5 * 3_600_000;

export const AUTH_MISSING = 'infra: subscription_auth_missing';
export const LIMIT_HIT = 'infra: subscription_limit';

export function codexAuthFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex'), 'auth.json');
}

/**
 * The subscription login exists. claude: CLAUDE_CODE_OAUTH_TOKEN is set. codex: auth.json holds a ChatGPT login (`tokens`)
 * and no API key — an API-key login would bill per token, so it counts as missing. Values are inspected in memory only.
 */
export function subscriptionAuthPresent(runtime: SubscriptionRuntime, env: NodeJS.ProcessEnv = process.env): boolean {
  if (runtime === 'claude') return Boolean(env.CLAUDE_CODE_OAUTH_TOKEN?.trim());
  try {
    const auth = JSON.parse(fs.readFileSync(codexAuthFile(env), 'utf8')) as { OPENAI_API_KEY?: unknown; tokens?: unknown };
    return !auth.OPENAI_API_KEY && Boolean(auth.tokens) && typeof auth.tokens === 'object';
  } catch { return false; }
}

const LIMIT_RE = /usage limit|rate[ _-]?limit|hit your limit|limit reached|usage_limit_reached|too many requests|\b429\b|quota exceeded|insufficient_quota/i;
/** A failed run whose CLI output says the subscription window is exhausted (only failed runs: a fix may mention rate limits). */
export function isSubscriptionLimit(exitStatus: unknown, stdout: string, stderr: string): boolean {
  if (exitStatus === 0) return false;
  return LIMIT_RE.test(stderr) || LIMIT_RE.test(stdout.slice(-4_000));
}

/** The species hit its subscription limit within the backoff window. */
export function inLimitBackoff(db: Database, runtime: SubscriptionRuntime, now = Date.now(), env: NodeJS.ProcessEnv = process.env): boolean {
  const since = new Date(now - subscriptionLimitBackoffMs(env)).toISOString();
  return (db.prepare(`SELECT COUNT(*) AS n FROM loop_runs WHERE json_extract(metadata, '$.gym.species') = ?
    AND json_extract(metadata, '$.gym.subscription') = 1 AND json_extract(metadata, '$.gym_result.reason') = ? AND created_at >= ?`).get(runtime, LIMIT_HIT, since) as { n: number }).n > 0;
}

export function subscriptionAttemptsToday(db: Database, runtime: SubscriptionRuntime, now = Date.now()): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM loop_runs WHERE json_extract(metadata, '$.gym.species') = ?
    AND json_extract(metadata, '$.gym.subscription') = 1 AND created_at >= ?`).get(runtime, new Date(now - 86_400_000).toISOString()) as { n: number }).n;
}

/**
 * Evidence (nested under gym_prod_gates): per subscription species over the window — attempts, scored, successes, success
 * rate with a Wilson 95 % interval (null + 'insufficient' below 10 scored: never 0), limit hits and auth-missing refusals.
 */
export function subscriptionGymEvidence(db: Database, since: string, env: NodeJS.ProcessEnv = process.env) {
  const enabled = subscriptionGymSpecies(env);
  const species = RUNTIMES.map((runtime) => {
    let r: { attempts: number; scored: number; successes: number; limit_hits: number; auth_missing: number } | undefined;
    try {
      r = db.prepare(`SELECT COUNT(*) AS attempts,
          COALESCE(SUM(json_extract(metadata, '$.gym_result.status') IN ('success', 'failure')), 0) AS scored,
          COALESCE(SUM(json_extract(metadata, '$.gym_result.status') = 'success'), 0) AS successes,
          COALESCE(SUM(json_extract(metadata, '$.gym_result.reason') = ?), 0) AS limit_hits,
          COALESCE(SUM(json_extract(metadata, '$.gym_result.reason') = ?), 0) AS auth_missing
        FROM loop_runs WHERE json_extract(metadata, '$.gym.species') = ? AND json_extract(metadata, '$.gym.subscription') = 1
          AND created_at >= ?`).get(LIMIT_HIT, AUTH_MISSING, runtime, since) as typeof r;
    } catch { r = undefined; }
    if (!r) return { species: runtime, enabled: enabled.includes(runtime), attempts: null, scored: null, successes: null, limit_hits: null, auth_missing: null, rate: null, ci: null, status: 'insufficient' as const };
    const ok = r.scored >= 10;
    return { species: runtime, enabled: enabled.includes(runtime), ...r, rate: ok ? +(r.successes / r.scored).toFixed(4) : null, ci: ok ? wilson(r.successes, r.scored) : null, status: ok ? 'ok' as const : 'insufficient' as const };
  });
  return { enabled, max_per_day: subscriptionGymMaxPerDay(env), species,
    note: 'local gym only (flat subscription, marginal cost 0, API keys stripped from the child). scored = success/failure; limit hits and auth refusals are infra discards. Wilson 95 %; insufficient below 10 scored.' };
}
