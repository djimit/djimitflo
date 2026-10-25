/**
 * Ollama Cloud account usage, read-only and fail-soft (operator 25-10: /usage showed 118 Djimitflo calls in 7 d and
 * "no limit recorded" while the Ollama account showed ~6,600 requests, the session at 100 % and the week at 89.7 %).
 * Djimitflo's ledger only sees its own calls; other services on the same account (DeerFlow, Hermes) and the requests inside
 * an opencode lease are invisible to it. Two first-party endpoints (docs read 2026-10-25):
 *   GET https://ollama.com/api/balance — https://docs.ollama.com/api/balance. Plans with session and weekly limits return
 *     included.session / included.weekly { remaining_percent 0–100, resets_at }; the new plans return included
 *     { balance_usd, allowance_usd, period { from, until } }; purchased.balance_usd = remaining unexpired purchased credits.
 *   GET https://ollama.com/api/usage?range=7d — https://docs.ollama.com/api/cloud-usage. totals.request_count and
 *     totals.usage_usd ("total value of the requests in USD") for scope self.
 * Both: Bearer API key, 10 requests per minute per user. OLLAMA_BALANCE_MODE=on to call (default off: no request at all).
 * Key: env[OLLAMA_ACCOUNT_KEY_ENV || 'SOCIAL_COMPAT_API_KEY'], never logged or returned. Cache 5 min, timeout 5 s.
 * Unknown is null with a reason, never 0. Requests use globalThis.fetch at call time, so the outbound guard
 * (OUTBOUND_DENY_HOSTS, utils/outbound-guard.ts) applies.
 */
export interface PctWindow { used_pct: number; resets_at: string | null }
export interface OllamaCredits {
  /** purchased.balance_usd: remaining unexpired purchased usage credits */
  balance_usd?: number;
  /** included.balance_usd / allowance_usd / period: new (credit-based) plans only */
  included_balance_usd?: number; included_allowance_usd?: number; included_period?: { from: string | null; until: string | null };
}
/** account-wide totals of /api/usage?range=7d; usage_value_usd = value of the requests at list rates, not credits drawn */
export interface OllamaWeek { request_count: number | null; usage_value_usd: number | null; from: string | null; until: string | null }
export interface OllamaAccountUsage {
  source: 'ollama_balance_api'; mode: 'off' | 'on'; fetched_at: string | null;
  session: PctWindow | null; weekly: PctWindow | null; credits: OllamaCredits | null; week: OllamaWeek | null;
  error?: string;
}

const BASE = 'https://ollama.com';
const CACHE_MS = 5 * 60_000;
const TIMEOUT_MS = 5_000;

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);

function pctWindow(v: unknown): PctWindow | null {
  const o = obj(v); const remaining = fin(o?.remaining_percent);
  if (remaining === null || remaining < 0 || remaining > 100) return null;
  return { used_pct: +(100 - remaining).toFixed(1), resets_at: iso(o!.resets_at) };
}

/** /api/balance body → percent windows and credits; only the fields the API returned, missing = null (never 0). */
export function parseOllamaBalance(raw: unknown): Pick<OllamaAccountUsage, 'session' | 'weekly' | 'credits'> {
  const root = obj(raw);
  if (!root) throw new Error('unexpected response shape');
  const inc = obj(root.included); const pur = obj(root.purchased);
  const credits: OllamaCredits = {};
  const purchased = fin(pur?.balance_usd); if (purchased !== null) credits.balance_usd = purchased;
  const incBalance = fin(inc?.balance_usd); if (incBalance !== null) credits.included_balance_usd = incBalance;
  const allowance = fin(inc?.allowance_usd); if (allowance !== null) credits.included_allowance_usd = allowance;
  const period = obj(inc?.period); if (period) credits.included_period = { from: iso(period.from), until: iso(period.until) };
  return { session: pctWindow(inc?.session), weekly: pctWindow(inc?.weekly), credits: Object.keys(credits).length ? credits : null };
}

/** /api/usage?range=7d body → account totals; no totals object = null. */
export function parseOllamaUsage(raw: unknown): OllamaWeek | null {
  const root = obj(raw); const totals = obj(root?.totals);
  if (!root || !totals) return null;
  const count = fin(totals.request_count); const value = fin(totals.usage_usd);
  return { request_count: count !== null && count >= 0 ? count : null, usage_value_usd: value !== null && value >= 0 ? value : null, from: iso(root.from), until: iso(root.until) };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function reasonOf(err: unknown, key: string): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timeout';
  if (e?.cause?.code === 'OUTBOUND_DENIED' || /OUTBOUND_DENIED/.test(e?.message ?? '')) return 'refused by the outbound guard (OUTBOUND_DENY_HOSTS)';
  return String(e?.message ?? err).split(key).join('[redacted]').slice(0, 160);
}

async function getJson(fetchImpl: FetchLike, url: string, key: string, timeoutMs: number): Promise<unknown> {
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const empty = (mode: 'off' | 'on', fetched_at: string | null, error?: string): OllamaAccountUsage =>
  ({ source: 'ollama_balance_api', mode, fetched_at, session: null, weekly: null, credits: null, week: null, ...(error ? { error } : {}) });

let cache: { at: number; keyVar: string; value: Promise<OllamaAccountUsage> } | null = null;
export function resetOllamaBalanceCache(): void { cache = null; }

export function fetchOllamaAccountUsage(opts: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike; now?: number; timeoutMs?: number } = {}): Promise<OllamaAccountUsage> {
  const env = opts.env ?? process.env; const now = opts.now ?? Date.now();
  if (env.OLLAMA_BALANCE_MODE !== 'on') return Promise.resolve(empty('off', null, 'OLLAMA_BALANCE_MODE is not on'));
  const keyVar = env.OLLAMA_ACCOUNT_KEY_ENV || 'SOCIAL_COMPAT_API_KEY';
  const key = env[keyVar];
  if (!key) return Promise.resolve(empty('on', null, `no Ollama key (${keyVar} is not set)`));
  if (cache && cache.keyVar === keyVar && now - cache.at < CACHE_MS) return cache.value;
  // resolved at call time so a guard installed after import still wraps it
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const value = (async () => {
    const [balance, usage] = await Promise.allSettled([
      getJson(fetchImpl, new URL('/api/balance', BASE).href, key, timeoutMs).then(parseOllamaBalance),
      getJson(fetchImpl, `${new URL('/api/usage', BASE).href}?range=7d`, key, timeoutMs).then(parseOllamaUsage),
    ]);
    const out = empty('on', new Date(now).toISOString());
    const errors: string[] = [];
    if (balance.status === 'fulfilled') Object.assign(out, balance.value); else errors.push(`balance: ${reasonOf(balance.reason, key)}`);
    if (usage.status === 'fulfilled') out.week = usage.value; else errors.push(`usage: ${reasonOf(usage.reason, key)}`);
    if (errors.length) out.error = errors.join('; ');
    return out;
  })();
  cache = { at: now, keyVar, value };
  return value;
}
