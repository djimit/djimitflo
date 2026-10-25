import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { ollamaLimitClass, readOllamaLimit } from './inference-failover';
import { LIMIT_HIT, subscriptionLimitBackoffMs } from './subscription-gym';
import type { OllamaAccountUsage } from './ollama-balance';

/**
 * /usage per provider ACCOUNT (operator 18-10: the page read token_usage_log, 0 rows in prod). Read-only over the records
 * that do exist: llm_model_calls (every server-side model call, B29 cost fields) and worker_leases (maker/checker CLI
 * sessions, metadata.token_accounting / runtime_usage), plus the inference state (system_state 'inference_ollama_state')
 * and subscription limit hits (ledger status 'subscription_limit', lease subscription_limit_hit_at / failure_reason).
 *
 * Counting rule (same as cost-ledger / resource-ledger v2): a lease is one call (one CLI session) with its tokens; the ledger
 * mirror of a lease is never counted again — consumer 'maker' (recordMakerCall) and the gym's subscription/free-tier maker
 * rows (evolution-gym subscriptionMakerRan) — but those mirror rows still count as limit evidence. Missing tokens are
 * counted apart (calls_without_tokens) and a window whose calls all lack tokens has tokens null (E2: unknown ≠ 0).
 * Windows: last 5 h rolling, today (UTC day), rolling 7 d, calendar month (UTC).
 */
export type AccountId = 'ollama_cloud' | 'claude_max' | 'chatgpt_pro' | 'opencode_free' | 'typesafe_jev' | 'nvidia' | 'local_workstation' | 'other';
export type CostBasisLabel = 'flat_subscription' | 'free_tier' | 'metered' | 'local' | 'unknown';

/**
 * The accounts and how they are paid. Mapping (first match wins, see accountOfCall / accountOfLease):
 *
 * | account            | llm_model_calls (provider + model)                                   | worker_leases (runtime + model)                         |
 * |--------------------|----------------------------------------------------------------------|---------------------------------------------------------|
 * | claude_max         | provider subscription-cli:claude                                     | runtime claude with subscription_auth or runtime_fallback |
 * | chatgpt_pro        | provider subscription-cli:codex                                      | runtime codex with subscription_auth                    |
 * | opencode_free      | provider free-tier-cli:opencode, model opencode/*                    | runtime opencode, model opencode/*                      |
 * | typesafe_jev       | provider typesafe (consumer jev)                                     | —                                                       |
 * | nvidia             | provider or model containing 'nvidia'                                | —                                                       |
 * | ollama_cloud       | provider ollama / ollama:<url> / *ollama.com*, model *:cloud or ollama/* | runtime opencode, model ollama/*                    |
 * | local_workstation  | provider local / llama-router / llama.cpp / 127.0.0.1 / localhost    | runtime remote, atomic                                  |
 * | other              | anything else (litellm, embedding-provider, openai:<url>, anthropic …) — listed with its raw provider | claude/codex without a recorded subscription marker (auth unknown) |
 *
 * Every Ollama provider row is Ollama Cloud: the same rule as inference-budget ollamaUsage7d, which counts them against the
 * weekly limit (the workstation daemon proxies :cloud models). runtime mock / manual are not usage.
 */
export const ACCOUNTS: ReadonlyArray<{ id: AccountId; label: string; cost_basis: CostBasisLabel }> = [
  { id: 'ollama_cloud', label: 'Ollama Cloud (subscription)', cost_basis: 'flat_subscription' },
  { id: 'claude_max', label: 'Claude Max (subscription via Claude Code)', cost_basis: 'flat_subscription' },
  { id: 'chatgpt_pro', label: 'ChatGPT Pro (Codex)', cost_basis: 'flat_subscription' },
  { id: 'opencode_free', label: 'OpenCode (free tier / Zen)', cost_basis: 'free_tier' },
  { id: 'typesafe_jev', label: 'TypeSafe jev', cost_basis: 'metered' },
  { id: 'nvidia', label: 'NVIDIA', cost_basis: 'free_tier' },
  { id: 'local_workstation', label: 'local workstation', cost_basis: 'local' },
  { id: 'other', label: 'Other / unmapped', cost_basis: 'unknown' },
];

/** Provider strings may carry a base URL; match the hostname, not a substring. */
function isOllamaHost(p: string): boolean {
  try { const h = new URL(p).hostname; return h === 'ollama.com' || h.endsWith('.ollama.com'); } catch { return false; }
}

export function accountOfCall(provider: string | null | undefined, model: string | null | undefined, consumer?: string | null): AccountId {
  const p = String(provider ?? '').toLowerCase(); const m = String(model ?? '').toLowerCase();
  if (p === 'subscription-cli:claude') return 'claude_max';
  if (p === 'subscription-cli:codex') return 'chatgpt_pro';
  if (p === 'free-tier-cli:opencode' || m.startsWith('opencode/')) return 'opencode_free';
  if (p === 'typesafe' || consumer === 'jev') return 'typesafe_jev';
  if (p.includes('nvidia') || m.includes('nvidia')) return 'nvidia';
  if (p === 'ollama' || p.startsWith('ollama:') || isOllamaHost(p) || m.endsWith(':cloud') || m.startsWith('ollama/') || m.startsWith('ollama:')) return 'ollama_cloud';
  if (['local', 'remote', 'llama-router', 'llama.cpp'].includes(p) || /127\.0\.0\.1|localhost|llama-router/.test(p)) return 'local_workstation';
  return 'other';
}

export function accountOfLease(runtime: string, model: string | null | undefined, subscribed: boolean): AccountId | null {
  const m = String(model ?? '').toLowerCase();
  if (runtime === 'mock' || runtime === 'manual') return null;
  if (runtime === 'claude') return subscribed ? 'claude_max' : 'other';
  if (runtime === 'codex') return subscribed ? 'chatgpt_pro' : 'other';
  if (runtime === 'opencode') return m.startsWith('ollama/') ? 'ollama_cloud' : m.startsWith('opencode/') ? 'opencode_free' : 'other';
  if (runtime === 'remote' || runtime === 'atomic') return 'local_workstation';
  return 'other';
}

/** One usage record (a ledger call or a lease session), normalised. */
export interface UsageRecord {
  account: AccountId; at: number; tokens: number | null; ok: boolean; consumer: string; provider: string; model: string | null;
  /** mirror rows: limit evidence only, never counted */
  mirror: boolean; limit_hit: boolean; /** when the limit hit (lease subscription_limit_hit_at), else at */ limit_at?: number; error: string | null; list_price_cost: number | null; cost_basis: string | null;
}

export type WindowId = '5h' | 'today' | '7d' | 'month';
export interface WindowSum { calls: number; tokens: number | null; calls_without_tokens: number }

/** Window starts (ms). today / month are UTC calendar boundaries. */
export function windowStarts(now: number): Record<WindowId, number> {
  const d = new Date(now);
  return { '5h': now - 5 * 3_600_000, today: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), '7d': now - 7 * 86_400_000,
    month: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) };
}

/** Calls and tokens per window over the counted (non-mirror) records; tokens null when every call lacked them. */
export function windowSums(records: UsageRecord[], now: number): Record<WindowId, WindowSum> {
  const starts = windowStarts(now);
  const out = {} as Record<WindowId, WindowSum>;
  for (const w of Object.keys(starts) as WindowId[]) {
    const rs = records.filter((r) => !r.mirror && r.at >= starts[w] && r.at <= now);
    const known = rs.filter((r) => r.tokens !== null);
    out[w] = { calls: rs.length, tokens: rs.length && !known.length ? null : known.reduce((s, r) => s + (r.tokens ?? 0), 0), calls_without_tokens: rs.length - known.length };
  }
  return out;
}

// ---- plan limits (docs/usage-plan-limits.json) ----
/** session = a vendor session of unpublished length (compared with our last 5 h); none = no window published (compared with the month). */
export type LimitWindow = '5h' | 'session' | 'weekly' | 'daily' | 'monthly' | 'none';
export type LimitUnit = 'tokens' | 'messages' | 'requests' | 'credits' | 'unknown';
export interface PlanLimit {
  account: AccountId; plan: string; window: LimitWindow; unit: LimitUnit; limit: number | null; limit_text: string; source_url: string | null; checked_at: string | null;
  /** 'first_party' | 'snippet, verify' (search-result excerpt, page not read) */
  confidence: string | null; note: string | null; exceed_behaviour: string | null;
}
/** account_plan: the plan (a row's exact `plan`) each account is on; 'unknown' / absent = every row is a candidate. */
export type AccountPlan = Partial<Record<AccountId, string>>;
const LIMIT_WINDOWS: readonly LimitWindow[] = ['5h', 'session', 'weekly', 'daily', 'monthly', 'none'];
const LIMIT_UNITS: readonly LimitUnit[] = ['tokens', 'messages', 'requests', 'credits', 'unknown'];
/** The vendor window → the window we measure it with (weekly = rolling 7 d: a vendor's fixed weekly reset is not known). */
const MEASURED_WINDOW: Record<LimitWindow, WindowId> = { '5h': '5h', session: '5h', weekly: '7d', daily: 'today', monthly: 'month', none: 'month' };
export const PLAN_LIMITS_PATH = path.resolve(__dirname, '../../../../docs/usage-plan-limits.json');

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
export function parsePlanLimits(raw: unknown): { limits: PlanLimit[]; invalid: number; account_plan: AccountPlan } {
  const doc = (raw && typeof raw === 'object' ? raw : {}) as { provider_plan_limits?: unknown; account_plan?: unknown };
  const account_plan: AccountPlan = {};
  if (doc.account_plan && typeof doc.account_plan === 'object') {
    for (const [k, v] of Object.entries(doc.account_plan as Record<string, unknown>)) {
      if (ACCOUNTS.some((a) => a.id === k) && typeof v === 'string' && v.trim() && v !== 'unknown') account_plan[k as AccountId] = v;
    }
  }
  const list = doc.provider_plan_limits;
  if (!Array.isArray(list)) return { limits: [], invalid: 0, account_plan };
  const limits: PlanLimit[] = []; let invalid = 0;
  for (const e of list as Array<Record<string, unknown>>) {
    const ok = e && ACCOUNTS.some((a) => a.id === e.account) && typeof e.plan === 'string' && LIMIT_WINDOWS.includes(e.window as LimitWindow)
      && LIMIT_UNITS.includes(e.unit as LimitUnit) && (e.limit === null || (typeof e.limit === 'number' && Number.isFinite(e.limit) && e.limit > 0));
    if (!ok) { invalid++; continue; }
    limits.push({ account: e.account as AccountId, plan: e.plan as string, window: e.window as LimitWindow, unit: e.unit as LimitUnit, limit: e.limit as number | null,
      limit_text: str(e.limit_text) ?? '', source_url: str(e.source_url), checked_at: str(e.checked_at), confidence: str(e.confidence), note: str(e.note),
      exceed_behaviour: str(e.exceed_behaviour) });
  }
  return { limits, invalid, account_plan };
}

export function loadPlanLimits(file = PLAN_LIMITS_PATH): ReturnType<typeof parsePlanLimits> & { source: string; error: string | null } {
  try { return { ...parsePlanLimits(JSON.parse(fs.readFileSync(file, 'utf8'))), source: 'docs/usage-plan-limits.json', error: null }; } catch (err) {
    return { limits: [], invalid: 0, account_plan: {}, source: 'docs/usage-plan-limits.json', error: (err as Error).message.slice(0, 160) };
  }
}

export interface LimitView extends PlanLimit {
  measured_window: WindowId; measured_unit: 'tokens' | 'calls'; used: number | null;
  /** a bar is drawn only when a number exists and the units are comparable */
  comparable: boolean; used_pct: number | null; unit_note: string | null;
  /** true = the account's configured plan, false = another plan (reference), null = account_plan unknown */
  active: boolean | null;
  /** set when used_pct is the vendor's own percent (Ollama balance API, account-wide) instead of our ledger */
  pct_source?: 'ollama_balance_api'; resets_at?: string | null;
}

/** The Ollama balance API percent fills the session / weekly rows of the active (or unknown) plan: same unit (percent of the account limit). */
export function withAccountPct(v: LimitView, au: OllamaAccountUsage | null | undefined): LimitView {
  const w = v.window === 'session' ? au?.session : v.window === 'weekly' ? au?.weekly : null;
  if (!w || v.active === false) return v;
  return { ...v, comparable: true, used_pct: w.used_pct, pct_source: 'ollama_balance_api', resets_at: w.resets_at,
    unit_note: "percent of the account limit as reported by the Ollama balance API (account-wide, every client); the calls / tokens above are Djimitflo's share only" };
}

/** A plan limit against what we measured. Tokens vs tokens compare; requests vs calls compare with a caveat; the rest do not. */
export function limitView(l: PlanLimit, sums: Record<WindowId, WindowSum>, accountPlan: AccountPlan = {}): LimitView {
  const w = MEASURED_WINDOW[l.window]; const s = sums[w];
  const measuredUnit: 'tokens' | 'calls' = l.unit === 'requests' ? 'calls' : 'tokens';
  const used = measuredUnit === 'calls' ? s.calls : s.tokens;
  const windowNote = l.window === 'session' ? 'session length not published; shown against our last 5 h. ' : l.window === 'none' ? 'no window published; shown against this month. ' : '';
  const plan = accountPlan[l.account];
  const unitNote = l.unit === 'tokens' ? (s.calls_without_tokens ? `${s.calls_without_tokens} calls without reported tokens are not in 'used'` : null)
    : l.unit === 'requests' ? 'vendor counts requests; we count calls (a CLI session counts once but makes many requests)'
    : l.unit === 'unknown' ? 'vendor unit unknown; we measure tokens — not comparable'
    : `vendor counts ${l.unit}; we measure tokens — not comparable`;
  const comparable = l.limit !== null && (l.unit === 'tokens' || l.unit === 'requests') && used !== null;
  const note = `${windowNote}${unitNote ?? ''}`.trim() || null;
  return { ...l, measured_window: w, measured_unit: measuredUnit, used, comparable, used_pct: comparable ? +((used! / l.limit!) * 100).toFixed(1) : null, unit_note: note,
    active: plan === undefined ? null : plan === l.plan };
}

// ---- records ----
const isoMs = (s: string): number => Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const LIMIT_TEXT = /subscription_limit|usage[ _]limit|rate[ _-]?limit|\b429\b|quota|too many requests|FreeUsageLimitError|FreeTierError/i;
const MIRROR_PURPOSES = new Set(['evolution_gym:subscription_maker', 'evolution_gym:free_tier_maker']);

export function loadRecords(db: Database, since: string): { records: UsageRecord[]; sources: Record<'llm_model_calls' | 'worker_leases', 'ok' | 'missing'> } {
  const records: UsageRecord[] = [];
  const sources = { llm_model_calls: 'ok' as 'ok' | 'missing', worker_leases: 'ok' as 'ok' | 'missing' };
  try {
    type Row = { consumer: string; model: string; provider: string | null; ok: number; tokens_in: number | null; tokens_out: number | null; status: string | null;
      purpose: string | null; cost_basis: string | null; list_price_cost: number | null; created_at: string };
    const rows = db.prepare(`SELECT consumer, model, provider, ok, tokens_in, tokens_out, status, purpose, cost_basis, list_price_cost, created_at
      FROM llm_model_calls WHERE created_at >= ?`).all(since) as Row[];
    for (const r of rows) {
      const tokens = r.tokens_in === null && r.tokens_out === null ? null : (r.tokens_in ?? 0) + (r.tokens_out ?? 0);
      const failed = r.ok !== 1;
      records.push({ account: accountOfCall(r.provider, r.model, r.consumer), at: isoMs(r.created_at), tokens, ok: !failed, consumer: r.purpose || r.consumer,
        provider: r.provider ?? '(none)', model: r.model, mirror: r.consumer === 'maker' || MIRROR_PURPOSES.has(r.purpose ?? ''),
        limit_hit: failed && (r.status === 'subscription_limit' || ollamaLimitClass(r.status) !== null || LIMIT_TEXT.test(r.status ?? '')),
        error: failed ? (r.status ?? 'failed') : null, list_price_cost: r.list_price_cost, cost_basis: r.cost_basis });
    }
  } catch { sources.llm_model_calls = 'missing'; }
  try {
    type Row = { role: string; runtime: string; status: string; created_at: string; loop_name: string | null; ta_total: unknown; ru_total: unknown; ta_model: string | null;
      model: string | null; from_model: string | null; sub_auth: string | null; fallback: number; limit_hit_at: string | null; failure_reason: string | null; cost: unknown };
    const rows = db.prepare(`SELECT l.role, l.runtime, l.status, l.created_at, r.loop_name,
        json_extract(l.metadata, '$.token_accounting.total_tokens') AS ta_total, json_extract(l.metadata, '$.runtime_usage.total_tokens') AS ru_total,
        json_extract(l.metadata, '$.token_accounting.model_id') AS ta_model, json_extract(l.metadata, '$.model') AS model,
        json_extract(l.metadata, '$.runtime_fallback.from_model') AS from_model, json_extract(l.metadata, '$.subscription_auth') AS sub_auth,
        json_extract(l.metadata, '$.runtime_fallback') IS NOT NULL AS fallback, json_extract(l.metadata, '$.subscription_limit_hit_at') AS limit_hit_at,
        json_extract(l.metadata, '$.failure_reason') AS failure_reason, json_extract(l.metadata, '$.token_accounting.estimated_cost_usd') AS cost
      FROM worker_leases l LEFT JOIN loop_runs r ON r.id = l.loop_run_id WHERE l.created_at >= ? AND l.status != 'prepared'`).all(since) as Row[];
    for (const r of rows) {
      const model = r.ta_model ?? r.model;
      const account = accountOfLease(r.runtime, model, Boolean(r.sub_auth) || r.fallback === 1);
      if (!account) continue;
      const limited = Boolean(r.limit_hit_at) || r.failure_reason === LIMIT_HIT;
      records.push({ account, at: isoMs(r.created_at), ...(r.limit_hit_at ? { limit_at: isoMs(r.limit_hit_at) } : {}), tokens: num(r.ta_total) ?? num(r.ru_total), ok: r.status !== 'failed',
        consumer: `lease:${r.role}:${r.loop_name ?? 'unknown'}${r.fallback === 1 ? ' (ollama outage fallback)' : ''}`, provider: `lease:${r.runtime}`, model,
        mirror: false, limit_hit: limited, error: r.status === 'failed' && limited ? LIMIT_HIT : null, list_price_cost: num(r.cost), cost_basis: null });
    }
  } catch { sources.worker_leases = 'missing'; }
  return { records, sources };
}

export interface AccountState { state: 'limit_reached' | 'limited' | 'backoff' | 'no_limit_recorded'; since: string | null; until: string | null; reason: string | null }

export function accountState(db: Database, account: AccountId, records: UsageRecord[], now: number, env: NodeJS.ProcessEnv = process.env,
  accountUsage?: OllamaAccountUsage | null): AccountState {
  if (account === 'ollama_cloud') {
    // first-party, account-wide: a window at >= 100 % is reached whatever Djimitflo's own ledger shows
    const full = (['session', 'weekly'] as const).filter((w) => (accountUsage?.[w]?.used_pct ?? 0) >= 100);
    if (full.length) {
      const resets = full.map((w) => accountUsage![w]!.resets_at).filter((r): r is string => Boolean(r)).sort();
      const credits = accountUsage!.credits?.balance_usd;
      return { state: 'limit_reached', since: accountUsage!.fetched_at, until: resets.at(-1) ?? null,
        reason: `Ollama balance API: ${full.map((w) => `${w} ${accountUsage![w]!.used_pct} % used`).join(', ')}${credits !== undefined ? `; purchased usage credits left: $${credits.toFixed(2)}` : ''}` };
    }
    const s = readOllamaLimit(db);
    if (s) return { state: 'limited', since: s.detected_at, until: null, reason: `${s.error_class} usage limit (${s.excerpt}); cleared when the 30-min probe succeeds` };
  }
  if (account === 'claude_max' || account === 'chatgpt_pro' || account === 'opencode_free') {
    const hitAt = (r: UsageRecord) => r.limit_at ?? r.at;
    const hit = records.filter((r) => r.account === account && r.limit_hit).sort((a, b) => hitAt(b) - hitAt(a))[0];
    const until = hit ? hitAt(hit) + subscriptionLimitBackoffMs(env) : 0;
    if (hit && until > now) return { state: 'backoff', since: new Date(hitAt(hit)).toISOString(), until: new Date(until).toISOString(),
      reason: `subscription limit hit (${hit.error ?? 'subscription_limit'}); Djimitflo backs off for SUBSCRIPTION_GYM_LIMIT_BACKOFF_MS` };
  }
  return { state: 'no_limit_recorded', since: null, until: null, reason: null };
}

const NOT_QUERIED: OllamaAccountUsage = { source: 'ollama_balance_api', mode: 'off', fetched_at: null, session: null, weekly: null, credits: null, week: null,
  error: 'not queried' };

/** The full per-account view. ollamaAccountUsage: the Ollama balance API result (routes/usage.ts fetches it; absent = not queried). */
export function usageAccounts(db: Database, opts: { now?: number; env?: NodeJS.ProcessEnv; planLimits?: ReturnType<typeof loadPlanLimits>; ollamaAccountUsage?: OllamaAccountUsage | null } = {}) {
  const now = opts.now ?? Date.now(); const env = opts.env ?? process.env;
  const starts = windowStarts(now);
  const since = new Date(Math.min(starts.month, starts['7d']) - 86_400_000).toISOString().slice(0, 10); // date prefix: both timestamp formats compare
  const { records, sources } = loadRecords(db, since);
  const plan = opts.planLimits ?? loadPlanLimits();
  const accounts = ACCOUNTS.map((a) => {
    const rs = records.filter((r) => r.account === a.id);
    const sums = windowSums(rs, now);
    const counted7d = rs.filter((r) => !r.mirror && r.at >= starts['7d']);
    const consumers = new Map<string, { consumer: string; calls: number; tokens: number; calls_without_tokens: number }>();
    for (const r of counted7d) {
      const c = consumers.get(r.consumer) ?? { consumer: r.consumer, calls: 0, tokens: 0, calls_without_tokens: 0 };
      c.calls++; if (r.tokens === null) c.calls_without_tokens++; else c.tokens += r.tokens;
      consumers.set(r.consumer, c);
    }
    const month = rs.filter((r) => !r.mirror && r.at >= starts.month);
    const priced = month.filter((r) => r.list_price_cost !== null);
    const lastError = rs.filter((r) => r.error).sort((x, y) => y.at - x.at)[0];
    const lastLimit = rs.filter((r) => r.limit_hit).sort((x, y) => y.at - x.at)[0];
    // a CLI lease session counts once although it makes many requests (we never see them); counted apart so the page can say so
    const lease_sessions = Object.fromEntries((Object.keys(starts) as WindowId[]).map((w) =>
      [w, rs.filter((r) => !r.mirror && r.provider.startsWith('lease:') && r.at >= starts[w] && r.at <= now).length])) as Record<WindowId, number>;
    const accountUsage = a.id === 'ollama_cloud' ? (opts.ollamaAccountUsage ?? NOT_QUERIED) : undefined;
    const brief = (r: UsageRecord | undefined) => r ? { at: new Date(r.at).toISOString(), message: r.error ?? 'limit', consumer: r.consumer, model: r.model } : null;
    return {
      id: a.id, label: a.label, scope: 'djimitflo_ledger' as const, windows: sums, lease_sessions,
      ...(accountUsage ? { account_usage: accountUsage } : {}),
      consumers_7d: [...consumers.values()].map((c) => ({ ...c, tokens: c.calls === c.calls_without_tokens ? null : c.tokens })).sort((x, y) => y.calls - x.calls),
      providers_seen: [...new Set(rs.map((r) => r.provider))].sort(),
      last_error: brief(lastError), last_limit_hit: brief(lastLimit), state: accountState(db, a.id, records, now, env, accountUsage),
      cost: { basis: a.cost_basis, observed_bases: [...new Set(month.map((r) => r.cost_basis).filter((b): b is string => Boolean(b)))].sort(),
        list_price_usd_month: priced.length ? +priced.reduce((s, r) => s + (r.list_price_cost ?? 0), 0).toFixed(6) : null, calls_without_list_price_month: month.length - priced.length },
      plan: plan.account_plan[a.id] ?? 'unknown',
      limits: plan.limits.filter((l) => l.account === a.id).map((l) => withAccountPct(limitView(l, sums, plan.account_plan), accountUsage)),
    };
  }).filter((a) => a.id !== 'other' || a.providers_seen.length > 0);
  return { generated_at: new Date(now).toISOString(), window_starts: Object.fromEntries(Object.entries(starts).map(([k, v]) => [k, new Date(v).toISOString()])),
    sources, plan_limits: { source: plan.source, entries: plan.limits.length, invalid: plan.invalid, error: plan.error }, accounts,
    note: "Calls and tokens are Djimitflo's share, as recorded (scope djimitflo_ledger): llm_model_calls rows + worker_leases CLI sessions. A lease counts once although the CLI makes many requests; ledger mirrors of a lease are not counted twice; other services on the same vendor account are not in it. tokens null = calls without reported tokens. today/month are UTC; a vendor weekly limit is compared with our rolling 7 d. Account-wide Ollama figures come only from the Ollama balance API (OLLAMA_BALANCE_MODE=on)." };
}
