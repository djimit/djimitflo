import fs from 'node:fs';
import type { Database } from 'better-sqlite3';
import { PLAN_LIMITS_PATH } from './usage-accounts';
import { integrateWh, hostSamples } from './resource-ledger';
import { supersededMergeOutcomeSql } from './merge-superseded';
import { HUMAN } from './evolution-lineage';

/**
 * Phase G0.3 + G0.4 (read-only): what a verified and a surviving change cost in € and in operator minutes over 30 d.
 *
 * € (G0.3): the operator fills `monthly_eur` in docs/usage-plan-limits.json — the monthly € of each subscription and the
 * VPS, plus the workstation's €/kWh. Monthly € are pro-rated to the window; the workstation costs measured GPU kWh
 * (host_power_samples, every metered host) × €/kWh. A null price is UNKNOWN, never 0: the total is the sum of the known
 * components (a lower bound) and `unknown_share` is the fraction of the cost components without a € figure. All
 * components unknown → every € value null with reason 'no_prices'.
 *   verified  = self_improvements that reached status 'verified' in the window (same rule as the cockpit scorecard)
 *   surviving = skill_outcomes domain 'merge' success 1 in the window, superseded closes excluded (merge-superseded.ts)
 *
 * Operator minutes (G0.4): approvals decided by a human (evolution-lineage HUMAN: autonomy / inherit / agent / system /
 * auto actors excluded) — waiting = decided_at − created_at capped at 24 h per item — and loop PRs merged by a human (not
 * the earned auto-merge). Handling time is not recorded anywhere, so it is HANDLING_MINUTES per item, labelled an estimate.
 */
export const UNIT_ECONOMICS_WINDOW_DAYS = 30;
/** ponytail: a fixed per-item handling estimate; replace with measured time if the dashboard ever records it */
export const HANDLING_MINUTES = 2;
export const APPROVAL_WAIT_CAP_MINUTES = 24 * 60;
const DAYS_PER_MONTH = 365.25 / 12;
export const MONTHLY_EUR_KEYS = ['ollama_cloud', 'claude_max', 'chatgpt_pro', 'vps'] as const;
export type MonthlyEurKey = (typeof MONTHLY_EUR_KEYS)[number];
/** monthly € per account + workstation €/kWh; null = the operator has not given a price */
export type EurPrices = Record<MonthlyEurKey, number | null> & { workstation_kwh_eur: number | null };

const price = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
export function parseMonthlyEur(raw: unknown): EurPrices {
  const m = ((raw as { monthly_eur?: unknown } | null)?.monthly_eur ?? {}) as Record<string, unknown>;
  const out = { workstation_kwh_eur: price(m.workstation_kwh_eur) } as EurPrices;
  for (const k of MONTHLY_EUR_KEYS) out[k] = price(m[k]);
  return out;
}
export function loadMonthlyEur(file = PLAN_LIMITS_PATH): { prices: EurPrices; error: string | null } {
  try { return { prices: parseMonthlyEur(JSON.parse(fs.readFileSync(file, 'utf8'))), error: null }; } catch (err) {
    return { prices: parseMonthlyEur(null), error: (err as Error).message.slice(0, 160) };
  }
}

/** SQLite datetime('now') has no zone and a space; Date.parse would read it as local time. */
const parseTs = (s: string | null): number => (s ? Date.parse(/[T]/.test(s) ? s : `${s.replace(' ', 'T')}Z`) : NaN);
const r2 = (n: number) => +n.toFixed(2);
const per = (x: number | null, n: number | null): number | null => (x === null || !n ? null : r2(x / n));

export interface CostComponent { key: MonthlyEurKey | 'workstation_kwh'; eur: number | null; reason: string | null; kwh?: number | null; coverage_pct?: number | null }
export interface UnitEconomics {
  window_days: number;
  counts: { verified: number | null; surviving: number | null; superseded_excluded: number | null };
  eur: {
    prices: EurPrices; source: string; source_error: string | null; components: CostComponent[];
    /** sum of the known components (a lower bound while unknown_share > 0); null when none is known */
    known_cost: number | null; unknown_share: number; reason: string | null;
    per_verified: number | null; per_surviving: number | null;
  };
  operator_minutes: {
    approvals: { human: number; excluded_automated: number; unknown_actor: number; waiting_minutes: number; handling_minutes_estimate: number } | null;
    human_merges: { count: number; handling_minutes_estimate: number } | null;
    waiting_minutes: number | null; handling_minutes_estimate: number | null;
    per_surviving: { waiting_minutes: number | null; handling_minutes_estimate: number | null };
    handling_minutes_per_item: number; reason: string | null;
  };
  errors: string[];
  notes: string[];
}

export function unitEconomics(db: Database, now = Date.now(), loaded = loadMonthlyEur(), days = UNIT_ECONOMICS_WINDOW_DAYS): UnitEconomics {
  const start = now - days * 86_400_000; const since = new Date(start).toISOString();
  const errors: string[] = [];
  const one = (label: string, sql: string, ...args: unknown[]): number | null => {
    try { return Number(Object.values(db.prepare(sql).get(...args) as Record<string, unknown>)[0] ?? 0); } catch (e) { errors.push(`${label}: ${(e as Error).message.slice(0, 160)}`); return null; }
  };
  const verified = one('verified', "SELECT COUNT(*) FROM self_improvements WHERE status = 'verified' AND updated_at >= ?", since);
  const mergeWins = `FROM skill_outcomes o WHERE o.domain = 'merge' AND o.success = 1 AND o.created_at >= ?`;
  const surviving = one('surviving', `SELECT COUNT(*) ${mergeWins} AND NOT ${supersededMergeOutcomeSql('o')}`, since);
  const superseded = one('superseded', `SELECT COUNT(*) ${mergeWins} AND ${supersededMergeOutcomeSql('o')}`, since);

  // ---- € ----
  const { prices } = loaded;
  const components: CostComponent[] = MONTHLY_EUR_KEYS.map((key) => (prices[key] === null
    ? { key, eur: null, reason: 'no_price' } : { key, eur: r2((prices[key] as number) * (days / DAYS_PER_MONTH)), reason: null }));
  let wh = 0; let covered = 0;
  try {
    for (const { host } of db.prepare('SELECT DISTINCT host FROM host_power_samples WHERE at >= ?').all(new Date(start - 180_000).toISOString()) as Array<{ host: string }>) {
      const e = integrateWh(hostSamples(db, host, start, now), start, now); wh += e.wh; covered = Math.max(covered, e.covered_s);
    }
  } catch { /* no power sample was ever stored: kWh unknown */ }
  const kwh = covered > 0 ? +(wh / 1000).toFixed(3) : null;
  const coverage_pct = covered > 0 ? +((100 * covered) / ((now - start) / 1000)).toFixed(1) : null;
  components.push(prices.workstation_kwh_eur === null ? { key: 'workstation_kwh', eur: null, reason: 'no_price', kwh, coverage_pct }
    : kwh === null ? { key: 'workstation_kwh', eur: null, reason: 'no_energy_samples', kwh, coverage_pct }
    : { key: 'workstation_kwh', eur: r2(kwh * prices.workstation_kwh_eur), reason: null, kwh, coverage_pct });
  const known = components.filter((c) => c.eur !== null);
  const known_cost = known.length ? r2(known.reduce((s, c) => s + (c.eur as number), 0)) : null;
  const allPricesNull = [...MONTHLY_EUR_KEYS.map((k) => prices[k]), prices.workstation_kwh_eur].every((p) => p === null);
  const eurReason = known_cost === null ? (allPricesNull ? 'no_prices' : 'no_known_cost') : null;

  // ---- operator minutes ----
  let approvals: UnitEconomics['operator_minutes']['approvals'] = null;
  try {
    const rows = db.prepare(`SELECT created_at, COALESCE(decided_at, approved_at, denied_at, updated_at) AS decided, COALESCE(decided_by, approved_by) AS actor
      FROM approvals WHERE status IN ('approved', 'denied') AND COALESCE(decided_at, approved_at, denied_at, updated_at) >= ?`).all(since.slice(0, 10)) as Array<{ created_at: string; decided: string; actor: string | null }>;
    const a = { human: 0, excluded_automated: 0, unknown_actor: 0, waiting_minutes: 0, handling_minutes_estimate: 0 };
    for (const r of rows) {
      const decided = parseTs(r.decided); if (!(decided >= start && decided <= now)) continue;
      if (!r.actor) { a.unknown_actor++; continue; }
      if (!HUMAN(r.actor)) { a.excluded_automated++; continue; }
      a.human++;
      const created = parseTs(r.created_at);
      if (Number.isFinite(created)) a.waiting_minutes += Math.min(Math.max(0, (decided - created) / 60_000), APPROVAL_WAIT_CAP_MINUTES);
    }
    a.waiting_minutes = r2(a.waiting_minutes); a.handling_minutes_estimate = a.human * HANDLING_MINUTES;
    approvals = a;
  } catch (e) { errors.push(`approvals: ${(e as Error).message.slice(0, 160)}`); }
  let human_merges: UnitEconomics['operator_minutes']['human_merges'] = null;
  try {
    const rows = db.prepare(`SELECT json_extract(metadata, '$.pr_outcome.merged_at') AS merged_at FROM loop_runs
      WHERE json_extract(metadata, '$.pr_url') IS NOT NULL AND json_extract(metadata, '$.pr_outcome.state') = 'merged'
        AND COALESCE(json_extract(metadata, '$.auto_merge.decision'), '') != 'merged'`).all() as Array<{ merged_at: string | null }>;
    const count = rows.filter((r) => { const t = parseTs(r.merged_at); return t >= start && t <= now; }).length;
    human_merges = { count, handling_minutes_estimate: count * HANDLING_MINUTES };
  } catch (e) { errors.push(`human_merges: ${(e as Error).message.slice(0, 160)}`); }
  const waiting = approvals ? approvals.waiting_minutes : null;
  const handling = approvals && human_merges ? approvals.handling_minutes_estimate + human_merges.handling_minutes_estimate : null;
  const minutesReason = surviving === null ? 'surviving_unknown' : surviving === 0 ? 'no_surviving_changes' : waiting === null || handling === null ? 'inputs_unreadable' : null;

  return {
    window_days: days,
    counts: { verified, surviving, superseded_excluded: superseded },
    eur: { prices, source: 'docs/usage-plan-limits.json monthly_eur', source_error: loaded.error, components, known_cost,
      unknown_share: +((components.length - known.length) / components.length).toFixed(3), reason: eurReason,
      per_verified: known_cost === null ? null : per(known_cost, verified), per_surviving: known_cost === null ? null : per(known_cost, surviving) },
    operator_minutes: { approvals, human_merges, waiting_minutes: waiting, handling_minutes_estimate: handling,
      per_surviving: { waiting_minutes: per(waiting, surviving), handling_minutes_estimate: per(handling, surviving) },
      handling_minutes_per_item: HANDLING_MINUTES, reason: minutesReason },
    errors,
    notes: [
      `Monthly € are pro-rated to ${days} d (× ${days} / ${DAYS_PER_MONTH.toFixed(2)}); workstation € = measured GPU kWh of every metered host × €/kWh (unsampled time is not costed).`,
      'unknown_share = cost components without a € figure / all components; while > 0 the € totals are lower bounds. Null price = unknown, never 0.',
      `Handling minutes are an estimate (${HANDLING_MINUTES} min per human approval or human merge), not measured. Waiting is capped at ${APPROVAL_WAIT_CAP_MINUTES / 60} h per approval.`,
    ],
  };
}
