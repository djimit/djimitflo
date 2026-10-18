import type { Database } from 'better-sqlite3';

/**
 * INFERENCE_BUDGET_THROTTLE (off|shadow|on, default shadow; operator 18-10): Ollama Cloud's weekly limit took the whole loop
 * down at once. With OLLAMA_WEEKLY_TOKEN_BUDGET (tokens per rolling 7 days; unset = no budget, never throttled) the Ollama
 * tokens of the last 7 days are summed — llm_model_calls tokens_in + tokens_out on an Ollama provider + token_accounting
 * total_tokens of opencode leases on an ollama/* model — and above OLLAMA_THROTTLE_AT (default 0.7) of the budget the
 * low-value consumers pause first: dream evolution, the Frontier Experts technique cards and capability reviews, and the
 * Commons residents (heartbeats, chat and committee forecasts). shadow = log what would pause, pause nothing. Makers and
 * checkers are never throttled (no gate on their path). Tokens, not calls (operator calibration 18-10): in the 7 d before
 * the limit hit there were 210 ledger calls but 21 opencode sessions with far more tokens each.
 */
export type ThrottleMode = 'off' | 'shadow' | 'on';
export const THROTTLED_CONSUMERS = ['dream_evolution', 'frontier_experts', 'residents'] as const;
export type ThrottledConsumer = typeof THROTTLED_CONSUMERS[number];

export const throttleMode = (env: NodeJS.ProcessEnv = process.env): ThrottleMode => {
  const v = env.INFERENCE_BUDGET_THROTTLE?.trim().toLowerCase();
  return v === 'off' || v === 'on' ? v : 'shadow';
};
/** OLLAMA_WEEKLY_TOKEN_BUDGET: a positive integer, else null (no budget = no throttle). */
export const weeklyTokenBudget = (env: NodeJS.ProcessEnv = process.env): number | null => {
  const n = Number(env.OLLAMA_WEEKLY_TOKEN_BUDGET);
  return env.OLLAMA_WEEKLY_TOKEN_BUDGET?.trim() && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};
export const throttleAt = (env: NodeJS.ProcessEnv = process.env): number => {
  const n = Number(env.OLLAMA_THROTTLE_AT);
  return env.OLLAMA_THROTTLE_AT?.trim() && Number.isFinite(n) && n > 0 ? n : 0.7;
};

const WEEK_MS = 7 * 86_400_000;
/**
 * Ollama tokens over the rolling 7 days; a part whose table is missing is null and so is the total (unknown, never 0).
 * ledger: tokens_in + tokens_out of rows on an Ollama provider (`ollama:<url>` transport rows, the panel's selector row —
 * B29 puts a call's tokens on one row only — residents/council `ollama`); rows without reported tokens are counted apart.
 * leases: token_accounting.total_tokens of opencode leases whose model is ollama/* (maker leases carry the accounting);
 * outage-fallback leases (ran on claude) are left out; leases without a reported total are counted apart.
 */
export function ollamaUsage7d(db: Database, now = Date.now()) {
  const since = new Date(now - WEEK_MS).toISOString();
  type Ledger = { tokens: number; calls: number; calls_without_tokens: number };
  type Leases = { tokens: number; leases: number; leases_without_tokens: number };
  let ledger: Ledger | null = null;
  try {
    ledger = db.prepare(`SELECT COALESCE(SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)), 0) AS tokens, COUNT(*) AS calls,
        COALESCE(SUM(tokens_in IS NULL AND tokens_out IS NULL), 0) AS calls_without_tokens
      FROM llm_model_calls WHERE created_at >= ? AND (provider = 'ollama' OR provider LIKE 'ollama:%')`).get(since) as Ledger;
  } catch { ledger = null; }
  let leases: Leases | null = null;
  try {
    leases = db.prepare(`SELECT COALESCE(SUM(json_extract(metadata, '$.token_accounting.total_tokens')), 0) AS tokens, COUNT(*) AS leases,
        COALESCE(SUM(json_extract(metadata, '$.token_accounting.total_tokens') IS NULL), 0) AS leases_without_tokens
      FROM worker_leases WHERE runtime = 'opencode' AND created_at >= ? AND json_extract(metadata, '$.runtime_fallback') IS NULL
        AND COALESCE(json_extract(metadata, '$.token_accounting.model_id'), json_extract(metadata, '$.model'), '') LIKE 'ollama/%'`).get(since) as Leases;
  } catch { leases = null; }
  const total = ledger && leases ? ledger.tokens + leases.tokens : null; // a missing part = unknown total (E2)
  return { ledger, opencode_leases: leases, total_tokens: total };
}

/** Usage against the budget: pct null without a budget or without data; over = pct ≥ OLLAMA_THROTTLE_AT. */
export function budgetState(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const budget = weeklyTokenBudget(env);
  const usage = ollamaUsage7d(db, now);
  const pct = budget !== null && usage.total_tokens !== null ? +(usage.total_tokens / budget).toFixed(4) : null;
  const status = budget === null ? 'no_budget' as const : pct === null ? 'insufficient' as const : pct >= throttleAt(env) ? 'over_threshold' as const : 'ok' as const;
  return { mode: throttleMode(env), token_budget: budget, throttle_at: throttleAt(env), usage, usage_pct: pct, status };
}

const CACHE_MS = 60_000;
let cached: { at: number; db: Database; over: boolean } | null = null;
const shadowLogged = new Map<string, number>();
/** Test hook. */
export function resetBudgetCache(): void { cached = null; shadowLogged.clear(); }

/**
 * Should this low-value consumer pause now? Only true with INFERENCE_BUDGET_THROTTLE=on, a token budget and usage ≥ the threshold.
 * shadow logs (once an hour per consumer) what would pause and returns false. Never throws.
 */
export function budgetPause(db: Database, consumer: ThrottledConsumer, env: NodeJS.ProcessEnv = process.env, now = Date.now()): boolean {
  const mode = throttleMode(env);
  if (mode === 'off' || weeklyTokenBudget(env) === null) return false;
  try {
    if (!cached || cached.db !== db || now - cached.at > CACHE_MS) cached = { at: now, db, over: budgetState(db, env, now).status === 'over_threshold' };
    if (!cached.over) return false;
    if (mode === 'on') return true;
    if (now - (shadowLogged.get(consumer) ?? 0) >= 3_600_000) {
      shadowLogged.set(consumer, now);
      console.warn(`🪫 inference budget (shadow): ${consumer} would pause — Ollama usage ≥ ${throttleAt(env) * 100} % of OLLAMA_WEEKLY_TOKEN_BUDGET`);
    }
    return false;
  } catch { return false; }
}

/** Evidence (under `inference.budget`): usage % and which consumers pause (on) or would pause (shadow). */
export function budgetEvidence(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const s = budgetState(db, env, now);
  const over = s.status === 'over_threshold' && s.mode !== 'off';
  return { ...s, paused: over && s.mode === 'on' ? [...THROTTLED_CONSUMERS] : [], would_pause: over && s.mode === 'shadow' ? [...THROTTLED_CONSUMERS] : [],
    note: 'Ollama tokens per rolling 7 d: llm_model_calls tokens_in+tokens_out on an Ollama provider + token_accounting.total_tokens of opencode leases on ollama/* models (rows/leases without reported tokens counted apart). Makers/checkers are never throttled. usage_pct null = no budget or no data.' };
}
