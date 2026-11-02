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
 *
 * `opencode-free:<model>` (operator 17-10): an OpenCode Zen free model (e.g. deepseek-v4.1-flash-free) through the opencode
 * CLI's built-in 'opencode' provider, model `opencode/<model>`. Zen refuses free models over the raw API (FreeTierError 'can
 * only be used from within OpenCode'), so they only run through the CLI. No login: without OPENCODE_API_KEY / an 'opencode'
 * auth entry the CLI (1.18) sends apiKey 'public' and drops every model whose input cost is not 0 — and the child env drops
 * OPENCODE_API_KEY with every other key, so a paid Zen model cannot even load. Only names ending in '-free' are accepted
 * (anything else is refused and listed in the evidence). Ledger provider `free-tier-cli:opencode`, cost_basis free_tier.
 */
export type SubscriptionRuntime = 'claude' | 'codex' | 'opencode';
/** One configured value. key = the gym species key (`$.gym.species`): runtime, or runtime@model. */
export interface SubscriptionSpecies { name: string; runtime: SubscriptionRuntime; key: string; model?: string; freeTier?: true }
const RUNTIMES = ['claude', 'codex'] as const;
const FREE_PREFIX = 'opencode-free:';
const FREE_MODEL = /^[a-z0-9][a-z0-9._-]*-free$/i;

/** SUBSCRIPTION_GYM_SPECIES parsed: accepted species (deduplicated, in order) and refused values (never run). */
export function parseSubscriptionSpecies(env: NodeJS.ProcessEnv = process.env): { species: SubscriptionSpecies[]; refused: string[] } {
  const species: SubscriptionSpecies[] = []; const refused: string[] = [];
  for (const raw of (env.SUBSCRIPTION_GYM_SPECIES || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const lower = raw.toLowerCase();
    let s: SubscriptionSpecies | null = null;
    if ((RUNTIMES as readonly string[]).includes(lower)) s = { name: lower, runtime: lower as SubscriptionRuntime, key: lower };
    else if (lower.startsWith(FREE_PREFIX) && FREE_MODEL.test(raw.slice(FREE_PREFIX.length))) {
      const model = `opencode/${raw.slice(FREE_PREFIX.length)}`;
      s = { name: raw, runtime: 'opencode', model, key: `opencode@${model}`, freeTier: true };
    }
    if (!s) refused.push(raw);
    else if (!species.some((x) => x.key === s!.key)) species.push(s);
  }
  return { species, refused };
}
export const subscriptionGymSpecies = (env: NodeJS.ProcessEnv = process.env): SubscriptionSpecies[] => parseSubscriptionSpecies(env).species;
export const subscriptionGymMaxPerDay = (env: NodeJS.ProcessEnv = process.env): number => Number(env.SUBSCRIPTION_GYM_MAX_PER_DAY) || 5;
export const subscriptionLimitBackoffMs = (env: NodeJS.ProcessEnv = process.env): number => Number(env.SUBSCRIPTION_GYM_LIMIT_BACKOFF_MS) || 5 * 3_600_000;

export const AUTH_MISSING = 'infra: subscription_auth_missing';
export const LIMIT_HIT = 'infra: subscription_limit';

export function codexAuthFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex'), 'auth.json');
}

/**
 * The subscription login exists. claude: CLAUDE_CODE_OAUTH_TOKEN is set. codex: auth.json holds a ChatGPT login (`tokens`)
 * and no API key — an API-key login would bill per token, so it counts as missing. opencode (free models): none needed. Values are inspected in memory only.
 */
export function subscriptionAuthPresent(runtime: SubscriptionRuntime, env: NodeJS.ProcessEnv = process.env): boolean {
  if (runtime === 'opencode') return true; // opencode-free: Zen free models need no login (the CLI sends apiKey 'public')
  if (runtime === 'claude') return Boolean(env.CLAUDE_CODE_OAUTH_TOKEN?.trim());
  try {
    const auth = JSON.parse(fs.readFileSync(codexAuthFile(env), 'utf8')) as { OPENAI_API_KEY?: unknown; tokens?: unknown };
    return !auth.OPENAI_API_KEY && Boolean(auth.tokens) && typeof auth.tokens === 'object';
  } catch { return false; }
}

const LIMIT_RE = /FreeUsageLimitError|FreeTierError|free usage exceeded|free_tier_limit|free limit reached|usage limit|rate[ _-]?limit|hit your limit|limit reached|usage_limit_reached|too many requests|\b429\b|quota exceeded|insufficient_quota/i;
/** A failed run whose CLI output says the subscription window is exhausted (only failed runs: a fix may mention rate limits). */
export function isSubscriptionLimit(exitStatus: unknown, stdout: string, stderr: string): boolean {
  if (exitStatus === 0) return false;
  return LIMIT_RE.test(stderr) || LIMIT_RE.test(stdout.slice(-4_000));
}

/**
 * One Claude subscription (Max) backoff for every caller: a limit hit by the claude gym species (loop_runs gym_result),
 * an OLLAMA_OUTAGE_FALLBACK_RUNTIME lease (worker_leases subscription_limit_hit_at) or a PANEL_FALLBACK_RUNTIME seat
 * (system_state 'subscription_limit:claude', the panel has no lease) benches all of them for SUBSCRIPTION_GYM_LIMIT_BACKOFF_MS.
 */
const CLAUDE_LIMIT_KEY = 'subscription_limit:claude';
export interface SubscriptionLimitHit { hit_at: string; source: string; until: string }

/** Record a Claude subscription usage-limit hit (a caller without a lease / loop_run of its own, e.g. the panel). */
export function recordSubscriptionLimit(db: Database, source: string, now = new Date()): void {
  try {
    db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(CLAUDE_LIMIT_KEY, JSON.stringify({ subscription_limit_hit_at: now.toISOString(), source: source.slice(0, 80) }), now.toISOString());
  } catch { /* system_state absent: the caller still treats this call as infra */ }
}

/** The latest Claude subscription limit hit within the backoff window over all callers, else null (unreadable source = skipped). */
export function claudeSubscriptionBackoff(db: Database, now = Date.now(), env: NodeJS.ProcessEnv = process.env): SubscriptionLimitHit | null {
  const since = new Date(now - subscriptionLimitBackoffMs(env)).toISOString();
  const hits: Array<{ hit_at: string; source: string }> = [];
  const read = (fn: () => { hit_at: string | null; source: string } | undefined) => { try { const r = fn(); if (r?.hit_at && r.hit_at >= since) hits.push(r as { hit_at: string; source: string }); } catch { /* table absent */ } };
  read(() => {
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(CLAUDE_LIMIT_KEY) as { value: string } | undefined;
    const v = row ? JSON.parse(row.value) as { subscription_limit_hit_at?: string; source?: string } : null;
    return v ? { hit_at: v.subscription_limit_hit_at ?? null, source: v.source ?? 'unknown' } : undefined;
  });
  read(() => db.prepare(`SELECT MAX(json_extract(metadata, '$.subscription_limit_hit_at')) AS hit_at, 'runtime_fallback' AS source FROM worker_leases
    WHERE json_extract(metadata, '$.runtime_fallback') IS NOT NULL AND json_extract(metadata, '$.subscription_limit_hit_at') >= ?`).get(since) as { hit_at: string | null; source: string });
  read(() => db.prepare(`SELECT MAX(created_at) AS hit_at, 'gym' AS source FROM loop_runs WHERE json_extract(metadata, '$.gym.species') = 'claude'
    AND json_extract(metadata, '$.gym.subscription') = 1 AND json_extract(metadata, '$.gym_result.reason') = ? AND created_at >= ?`).get(LIMIT_HIT, since) as { hit_at: string | null; source: string });
  const last = hits.sort((a, b) => (a.hit_at < b.hit_at ? 1 : -1))[0];
  return last ? { ...last, until: new Date(Date.parse(last.hit_at) + subscriptionLimitBackoffMs(env)).toISOString() } : null;
}

/** The species hit its subscription limit within the backoff window (claude: any Claude subscription caller did). */
export function inLimitBackoff(db: Database, key: string, now = Date.now(), env: NodeJS.ProcessEnv = process.env): boolean {
  if (key === 'claude') return claudeSubscriptionBackoff(db, now, env) !== null;
  const since = new Date(now - subscriptionLimitBackoffMs(env)).toISOString();
  return (db.prepare(`SELECT COUNT(*) AS n FROM loop_runs WHERE json_extract(metadata, '$.gym.species') = ?
    AND json_extract(metadata, '$.gym.subscription') = 1 AND json_extract(metadata, '$.gym_result.reason') = ? AND created_at >= ?`).get(key, LIMIT_HIT, since) as { n: number }).n > 0;
}

export function subscriptionAttemptsToday(db: Database, key: string, now = Date.now()): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM loop_runs WHERE json_extract(metadata, '$.gym.species') = ?
    AND json_extract(metadata, '$.gym.subscription') = 1 AND created_at >= ?`).get(key, new Date(now - 86_400_000).toISOString()) as { n: number }).n;
}

/**
 * Evidence (nested under gym_prod_gates): per subscription species over the window — attempts, scored, successes, success
 * rate with a Wilson 95 % interval (null + 'insufficient' below 10 scored: never 0), limit hits and auth-missing refusals.
 */
export function subscriptionGymEvidence(db: Database, since: string, env: NodeJS.ProcessEnv = process.env) {
  const { species: enabled, refused } = parseSubscriptionSpecies(env);
  const listed = [...RUNTIMES.map((r) => ({ name: r as string, key: r as string, freeTier: false })), ...enabled.filter((s) => s.freeTier).map((s) => ({ name: s.name, key: s.key, freeTier: true }))];
  const species = listed.map(({ name, key, freeTier }) => {
    const head = { species: name, key, enabled: enabled.some((s) => s.key === key), cost_basis: freeTier ? 'free_tier' as const : 'flat_subscription' as const };
    let r: { attempts: number; scored: number; successes: number; limit_hits: number; auth_missing: number } | undefined;
    try {
      r = db.prepare(`SELECT COUNT(*) AS attempts,
          COALESCE(SUM(json_extract(metadata, '$.gym_result.status') IN ('success', 'failure')), 0) AS scored,
          COALESCE(SUM(json_extract(metadata, '$.gym_result.status') = 'success'), 0) AS successes,
          COALESCE(SUM(json_extract(metadata, '$.gym_result.reason') = ?), 0) AS limit_hits,
          COALESCE(SUM(json_extract(metadata, '$.gym_result.reason') = ?), 0) AS auth_missing
        FROM loop_runs WHERE json_extract(metadata, '$.gym.species') = ? AND json_extract(metadata, '$.gym.subscription') = 1
          AND created_at >= ?`).get(LIMIT_HIT, AUTH_MISSING, key, since) as typeof r;
    } catch { r = undefined; }
    if (!r) return { ...head, attempts: null, scored: null, successes: null, limit_hits: null, auth_missing: null, rate: null, ci: null, status: 'insufficient' as const };
    const ok = r.scored >= 10;
    return { ...head, ...r, rate: ok ? +(r.successes / r.scored).toFixed(4) : null, ci: ok ? wilson(r.successes, r.scored) : null, status: ok ? 'ok' as const : 'insufficient' as const };
  });
  return { enabled: enabled.map((s) => s.name), refused, max_per_day: subscriptionGymMaxPerDay(env), species,
    note: 'local gym only (claude/codex: flat subscription; opencode-free:<model>: OpenCode Zen free tier, -free models only; marginal cost 0, API keys stripped from the child). scored = success/failure; limit hits and auth refusals are infra discards. Wilson 95 %; insufficient below 10 scored.' };
}
