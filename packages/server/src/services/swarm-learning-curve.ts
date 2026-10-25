import type { Database } from 'better-sqlite3';
import { wilson } from './evolution-estimators';
import { metricRef, usageEvents, type UsageEvent } from './cost-ledger';
import { experimentDefs } from './experiment-registry';

/**
 * SW-01 (swarm-evolution audit 2026-10-25): read-only truth for the swarm pages. Nothing is written.
 *
 * Learning curve: the old route compared the first and the last run's binary status and called it a success rate, and
 * priced tokens with a runtime-level fallback tariff (missing usage became $0). Here a rate is completed ÷ terminal runs
 * of one exact cohort (one loop_name — gym, maintenance and production are never pooled) over two equal consecutive
 * windows, with its denominator and a Wilson interval; the windows are compared only when both reach LEARNING_CURVE_MIN_N.
 * Tokens come from the cost-ledger usage events (one owner per event, mirrors excluded) with their coverage; usd only from
 * a dated price entry (cost-ledger PRICE_LIST) — otherwise null with the reason, never a fallback tariff.
 */

const DAY = 86_400_000;
export const LEARNING_CURVE_MIN_N = 10;
/** a run in one of these statuses has a final completion outcome; every other status is censored (still in flight / awaiting merge) */
export const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'escalated', 'cancelled', 'interrupted', 'blocked'] as const;
const TERMINAL = new Set<string>(TERMINAL_RUN_STATUSES);
export type RunClass = 'gym' | 'maintenance' | 'production';

export function runClass(loopName: string, metadata: Record<string, unknown> = {}): RunClass {
  if (loopName === 'evolution-gym' || (metadata.gym && typeof metadata.gym === 'object')) return 'gym';
  if (loopName === 'repo-maintenance-loop') return 'maintenance';
  return 'production';
}

const r3 = (x: number) => +x.toFixed(3);
function safeAll<T>(db: Database, sql: string, ...args: unknown[]): T[] { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } }
const parse = (s: string | null | undefined): Record<string, unknown> => { try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };

export interface TokenSummary { value: number | null; events: number; known: number; coverage: number | null; status: 'measured' | 'partial' | 'UNKNOWN' }
export interface UsdSummary { value: number | null; reason: string | null }

/** Tokens and usd over a set of usage events, each event once (by id); unknown is null, never 0. */
export function summarizeUsage(events: readonly UsageEvent[]): { tokens: TokenSummary; usd: UsdSummary } {
  const seen = new Map(events.map((e) => [e.id, e]));
  let tokens = 0; let known = 0; let usd = 0; let priced = true;
  for (const e of seen.values()) {
    if (e.tokens_reconciled === null) { priced = false; continue; }
    tokens += e.tokens_reconciled; known++;
    if (e.usd_inferred === null) priced = false; else usd += e.usd_inferred;
  }
  const n = seen.size;
  const coverage = n ? r3(known / n) : null;
  return {
    tokens: { value: known ? tokens : null, events: n, known, coverage, status: !known ? 'UNKNOWN' : known === n ? 'measured' : 'partial' },
    usd: n && priced ? { value: +usd.toFixed(6), reason: null }
      : { value: null, reason: !n ? 'no usage record' : known < n ? 'usage not reported for every record' : 'no dated price entry for a model (cost-ledger PRICE_LIST)' },
  };
}

interface RunRow { id: string; loop_name: string; status: string; created_at: string; metadata: string }

function windowStats(runs: RunRow[], byRun: Map<string, UsageEvent[]>) {
  const terminal = runs.filter((r) => TERMINAL.has(r.status));
  const completed = terminal.filter((r) => r.status === 'completed').length;
  const retries = terminal.map((r) => Number(parse(r.metadata).retry_count) || 0);
  return {
    n: terminal.length, completed, rate: terminal.length ? r3(completed / terminal.length) : null,
    ci: terminal.length ? wilson(completed, terminal.length) : null, censored: runs.length - terminal.length,
    mean_retries: retries.length ? r3(retries.reduce((a, b) => a + b, 0) / retries.length) : null,
    ...summarizeUsage(runs.flatMap((r) => byRun.get(r.id) ?? [])),
  };
}

export function learningCurveView(db: Database, now = Date.now(), days = 7, runLimit = 100) {
  const until = new Date(now).toISOString();
  const recentSince = new Date(now - days * DAY).toISOString();
  const priorSince = new Date(now - 2 * days * DAY).toISOString();
  const latest = safeAll<RunRow>(db, 'SELECT id, loop_name, status, created_at, metadata FROM loop_runs ORDER BY created_at DESC LIMIT ?', runLimit).reverse();
  const windowed = safeAll<RunRow>(db, 'SELECT id, loop_name, status, created_at, metadata FROM loop_runs WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC', priorSince, until);
  const usageSince = [priorSince, latest[0]?.created_at].filter((s): s is string => Boolean(s)).sort()[0];
  const byRun = new Map<string, UsageEvent[]>();
  for (const e of usageEvents(db, usageSince, until, { now }).events) if (e.run_id) byRun.set(e.run_id, [...(byRun.get(e.run_id) ?? []), e]);

  const runs = latest.map((r) => {
    const metadata = parse(r.metadata);
    const usage = summarizeUsage(byRun.get(r.id) ?? []);
    return {
      run_id: r.id, created_at: r.created_at,
      /** binary run status (status = completed), not a rate */
      success: r.status === 'completed',
      retries: Number(metadata.retry_count) || 0,
      /** inferred from a dated price entry only; null = unknown (no fallback tariff) */
      dollars: usage.usd.value,
      loop_name: r.loop_name, status: r.status, run_class: runClass(r.loop_name, metadata), terminal: TERMINAL.has(r.status),
      tokens: usage.tokens.value, usage_events: usage.tokens.events, usage_events_known: usage.tokens.known,
      cost_status: usage.usd.value === null ? 'UNKNOWN' as const : 'inferred' as const, cost_reason: usage.usd.reason,
    };
  });

  const cohorts = new Map<string, { prior: RunRow[]; recent: RunRow[]; cls: RunClass }>();
  for (const r of windowed) {
    const c = cohorts.get(r.loop_name) ?? { prior: [], recent: [], cls: runClass(r.loop_name, parse(r.metadata)) };
    if (runClass(r.loop_name, parse(r.metadata)) === 'gym') c.cls = 'gym';
    (r.created_at >= recentSince ? c.recent : c.prior).push(r);
    cohorts.set(r.loop_name, c);
  }
  const first = runs[0]; const last = runs[runs.length - 1];
  return {
    runs,
    /** kept for compatibility: a single run's status is not a rate and a missing price is not $0 — see cohorts */
    first_vs_last: {
      first_success_rate: null, last_success_rate: null, first_cost: null, last_cost: null,
      first_run_success: first ? first.success : null, last_run_success: last ? last.success : null,
      first_run_status: first?.status ?? null, last_run_status: last?.status ?? null,
      semantics: 'binary status of the first and last listed run; rates are per cohort and window (cohorts[])',
    },
    trend: { retries_decreasing: null, note: 'not computed from two single runs; see cohorts[].windows.*.mean_retries' },
    cohorts: [...cohorts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([loop_name, c]) => {
      const prior = windowStats(c.prior, byRun); const recent = windowStats(c.recent, byRun);
      const comparable = prior.n >= LEARNING_CURVE_MIN_N && recent.n >= LEARNING_CURVE_MIN_N;
      return {
        loop_name, run_class: c.cls, windows: { prior, recent },
        comparison: comparable
          ? { status: 'compared' as const, delta: r3((recent.rate ?? 0) - (prior.rate ?? 0)), reason: null }
          : { status: 'insufficient' as const, delta: null, reason: `each window needs ≥ ${LEARNING_CURVE_MIN_N} terminal runs (prior ${prior.n}, recent ${recent.n})` },
      };
    }),
    pooled: false,
    window: { days, prior: { since: priorSince, until: recentSince }, recent: { since: recentSince, until } },
    min_n_per_window: LEARNING_CURVE_MIN_N,
    definition: `rate = completed ÷ terminal runs (${TERMINAL_RUN_STATUSES.join(', ')}) per loop_name and window, by created_at; other statuses are censored. Run completion is not verified task success. Tokens: cost-ledger usage events of the window's runs (${metricRef('cost.usage_event').id}@${metricRef('cost.usage_event').version}); usd only from a dated price entry.`,
    registered_readouts: registeredReadouts(),
  };
}

/** The registered stop date of experiments these pages mention — the definition only; no status/effect is computed here. */
export function registeredReadouts() {
  return experimentDefs().filter((e) => e.id === 'memory-holdout').map((e) => ({
    id: e.id, protocol: e.protocol, stop_by: e.stop_by, stop_source: e.stop_source,
    analysis: 'registered single analysis', causal_conclusion: null,
    note: `readout due ${e.stop_by ? e.stop_by.slice(0, 10) : 'unregistered'} (registered single analysis); no causal conclusion before it`,
  }));
}

/** Recorded usage in [now − days, now) with its coverage (cost-ledger usage events, mirrors excluded); unknown is null. */
export function usageWindow(db: Database, now = Date.now(), days = 7) {
  const since = new Date(now - days * DAY).toISOString(); const until = new Date(now).toISOString();
  const { events, mirrors } = usageEvents(db, since, until, { now });
  const all = summarizeUsage(events).tokens;
  const part = (locality: UsageEvent['locality']) => summarizeUsage(events.filter((e) => e.locality === locality)).tokens.value;
  const bySource: Record<string, { events: number; known: number }> = {};
  for (const e of events) { const s = bySource[e.source] ?? { events: 0, known: 0 }; s.events++; if (e.tokens_reconciled !== null) s.known++; bySource[e.source] = s; }
  return {
    window_days: days, since, until,
    events: all.events, known_events: all.known, coverage: all.coverage, status: all.status,
    total_tokens: all.value, cloud_tokens: part('cloud'), local_tokens: part('local'),
    by_source: bySource,
    mirrors_excluded: { rows: mirrors.reduce((s, m) => s + m.rows, 0), tokens: mirrors.reduce((s, m) => s + m.tokens, 0) },
    metric: metricRef('cost.usage_event'),
    note: 'provider-reported tokens of worker leases, judgments and server model calls created in the window; a record without reported usage is unknown, not 0. Agent counters (agents.total_token_usage) are not used.',
  };
}
