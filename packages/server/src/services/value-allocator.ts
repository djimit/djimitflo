import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import { exclusiveWh, gpuJobs, hostSamples, isLocalModel, leaseConsumer, valuePer, type Interval, type Job } from './resource-ledger';
import { loopPrSettlements } from './merge-survival';
import { insertJudgmentRow } from './judgment-service';
import { listSchedulers, markRun } from './scheduler-registry';

/**
 * Phase E4 (SHADOW value allocator): what every consumer of compute spent and what it delivered, and what an allocator WOULD
 * do about it. Nothing is ever applied — no cap, share, flag or schedule changes; the proposal is a record for the operator.
 *
 * Consumer catalogue (derived from data, never hand-written): every judgment type, LLM purpose (llm_model_calls.purpose, or
 * `consumer:<consumer>` when unset) and maker runtime/species (worker_leases) seen in the last 7 days, plus every scheduler
 * this process armed or saw tick (scheduler registry; in-memory, rebuilt at boot). llm_model_calls rows of consumer 'maker'
 * mirror the lease (B29, as in resource-ledger tokenLedger v2) and un-purposed 'jev' rows are the judgments' own calls — both
 * are counted on the lease / judgment, never twice.
 *
 * Resources per window (7 d and 30 d): calls/runs; cloud and local tokens where reported — a NULL token count is UNKNOWN,
 * never 0 (unknown calls are counted apart; under MIN_TOKEN_COVERAGE known the cost is UNKNOWN_COST); a judgment row without
 * a model made no model call (basis no_model_call). Local GPU Wh from host_power_samples over the consumer's job windows
 * (resource-ledger exclusiveWh); not measured over ≥ 90 % of the job time = null (unknown), never an invented figure.
 *
 * Value: verified runs credited to the consumer in outcome_credits (E2 attribution) weighted 1, plus 3 for each of those runs
 * whose loop PR SETTLED_SURVIVED (fitness-view weights: production 1, merge 3). Judgments read by a gate in enforce mode
 * carry `decision_consumed`. A consumer whose output nobody reads (only shadow rows, `<judgment>@<model>` challenger/local
 * rows, llm rows all shadow = 1) is NO_CONSUMER: value 0 BY DESIGN, distinct from unknown. Without any attribution recorded in
 * the window, value is unknown (null), never 0.
 *
 * VALUE_ALLOCATOR_MODE=off (default) | shadow: one `value_allocation` shadow judgment per UTC day with the full table, and
 * GET /api/health/value-allocation (manage:config; 404 when off).
 */
export type ValueAllocatorMode = 'off' | 'shadow';
export const valueAllocatorMode = (env: NodeJS.ProcessEnv = process.env): ValueAllocatorMode => (env.VALUE_ALLOCATOR_MODE === 'shadow' ? 'shadow' : 'off');

export type ConsumerKind = 'scheduler' | 'judgment' | 'llm_purpose' | 'maker';
export type ConsumerStatus = 'decision_consumed' | 'consumed' | 'no_consumer' | 'unknown';
export type ValueClass = 'VALUE_PROVEN' | 'NO_VALUE' | 'NO_CONSUMER' | 'INSUFFICIENT' | 'UNKNOWN_COST';
export type ProposedAction = 'keep' | 'reduce_cap' | 'pause' | 'raise_share';

export const VALUE_WEIGHTS = { verified: 1, survived: 3 } as const;
/** NO_VALUE needs at least this many runs/calls with zero value; VALUE_PROVEN at least MIN_PROVEN_N with value > 0. */
export const MIN_VOLUME = 20;
export const MIN_PROVEN_N = 5;
/** below this share of calls with a reported token count the cloud cost is unknown */
export const MIN_TOKEN_COVERAGE = 0.5;
/** never propose below this share of current volume for VALUE_PROVEN or INSUFFICIENT consumers (keep exploring) */
export const EXPLORATION_FLOOR = 0.05;
const DAY = 86_400_000;

/** Never proposed for reduction or pause, whatever the numbers say. */
const HARD_FLOORS: Array<[RegExp, string]> = [
  [/(^|[^a-z])gates?([^a-z]|$)/i, 'gate'],
  [/security/i, 'security checker'],
  [/safety/i, 'safety gate'],
  [/human|manual[_-]?merge/i, 'human merge'],
  [/(^|[^a-z])auth|deploy|secret|credential/i, 'auth/deploy/secrets'],
  [/merge[_-]?survival/i, 'merge-survival poller'],
  [/stall/i, 'stall watch'],
];
export function hardFloor(consumer: string, status: ConsumerStatus): string | null {
  if (status === 'decision_consumed') return 'gate (judgment read in enforce mode)';
  const hit = HARD_FLOORS.find(([re]) => re.test(consumer));
  return hit ? hit[1] : null;
}

export interface WindowStats {
  window_days: number;
  runs: number;
  tokens: { cloud: number | null; local: number | null; known_calls: number; unknown_calls: number; coverage: number | null; basis: 'reported' | 'no_model_call' | 'not_recorded' };
  energy: { wh: number | null; status: 'measured' | 'partial' | 'not_measured' | 'no_local_jobs'; gpu_seconds: number };
  value: { verified: number | null; survived: number | null; units: number | null; decision_consumed: number | null; basis: string };
  per_m_tokens: Interval | null;
  per_kwh: Interval | null;
  class: ValueClass;
  reason: string;
}
export interface AllocationRow {
  consumer: string; kind: ConsumerKind; consumer_status: ConsumerStatus; hard_floor: string | null;
  w7: WindowStats; w30: WindowStats;
  proposal: { action: ProposedAction; share: number; reason: string };
}
export interface ValueAllocation {
  at: string; mode: ValueAllocatorMode; attribution_recorded: { w7: boolean; w30: boolean };
  by_class: Record<ValueClass, number>; by_action: Record<ProposedAction, number>;
  consumers: AllocationRow[]; notes: string[];
}

interface Acc {
  kind: ConsumerKind; runs: number; runIds: Set<string>; cloud: number; local: number; known: number; unknown: number; noModel: number;
  shadowRows: number; enforceRows: number; enforceConsumed: number; otherRows: number;
  gpuS: number; coveredS: number; wh: number;
}
const newAcc = (kind: ConsumerKind): Acc => ({ kind, runs: 0, runIds: new Set(), cloud: 0, local: 0, known: 0, unknown: 0, noModel: 0,
  shadowRows: 0, enforceRows: 0, enforceConsumed: 0, otherRows: 0, gpuS: 0, coveredS: 0, wh: 0 });

function safeAll<T>(db: Database, sql: string, ...args: unknown[]): T[] { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } }
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** gym and committee GPU jobs belong to the scheduler that runs them (resource-ledger names them gym:<species> / committee). */
const energyOwner = (jobConsumer: string): string =>
  jobConsumer.startsWith('gym:') ? 'scheduler:evolution_gym' : jobConsumer === 'committee' ? 'scheduler:committee_evolution' : jobConsumer;

/** Resources and consumer evidence per consumer key over [since, until). */
function collect(db: Database, since: string, until: string, schedulers: string[]): Map<string, Acc> {
  const out = new Map<string, Acc>();
  const acc = (key: string, kind: ConsumerKind) => { let a = out.get(key); if (!a) { a = newAcc(kind); out.set(key, a); } return a; };
  const tokens = (a: Acc, t: number | null, local: boolean) => {
    if (t === null) { a.unknown++; return; }
    a.known++; if (local) a.local += t; else a.cloud += t;
  };

  for (const r of safeAll<{ p: string; consumer: string; provider: string | null; model: string | null; shadow: number; tin: number | null; tout: number | null }>(db,
    `SELECT COALESCE(purpose, 'consumer:' || consumer) AS p, consumer, provider, model, shadow, tokens_in AS tin, tokens_out AS tout FROM llm_model_calls
      WHERE created_at >= ? AND created_at < ? AND consumer != 'maker' AND NOT (consumer = 'jev' AND purpose IS NULL)`, since, until)) {
    const a = acc(`llm:${r.p}`, 'llm_purpose'); a.runs++;
    if (r.shadow) a.shadowRows++; else a.otherRows++;
    const tin = num(r.tin); const tout = num(r.tout);
    tokens(a, tin === null && tout === null ? null : (tin ?? 0) + (tout ?? 0), isLocalModel(r.provider, r.model));
  }

  for (const r of safeAll<{ judgment: string; mode: string; decision: string; model: string | null; tin: number | null; tout: number | null }>(db,
    `SELECT judgment, mode, decision, model, input_tokens AS tin, output_tokens AS tout FROM judgments WHERE created_at >= ? AND created_at < ?`, since, until)) {
    const a = acc(`judgment:${r.judgment}`, 'judgment'); a.runs++;
    if (r.judgment.includes('@') || r.mode === 'shadow') a.shadowRows++;
    else if (r.mode === 'enforce') { a.enforceRows++; if (r.decision !== 'error') a.enforceConsumed++; }
    else a.otherRows++;
    if (!r.model) { a.noModel++; continue; } // deterministic: no model call was made
    // judgments.input/output_tokens are NOT NULL DEFAULT 0: a model row with 0 + 0 means the usage was not reported
    const t = (num(r.tin) ?? 0) + (num(r.tout) ?? 0);
    tokens(a, t > 0 ? t : null, isLocalModel(null, r.model));
  }

  for (const r of safeAll<{ run: string; runtime: string; model: string | null; ta: number | null; ru: number | null }>(db,
    // P0-7: an engine fallback is attributed to the runtime that ran (effective_runtime) with its model (unknown = none)
    `SELECT loop_run_id AS run, COALESCE(json_extract(metadata, '$.effective_runtime'), runtime) AS runtime,
      CASE WHEN json_extract(metadata, '$.effective_runtime') IS NOT NULL AND json_extract(metadata, '$.effective_runtime') != runtime
        THEN json_extract(metadata, '$.effective_model') ELSE json_extract(metadata, '$.model') END AS model, json_extract(metadata, '$.token_accounting.total_tokens') AS ta,
      json_extract(metadata, '$.runtime_usage.total_tokens') AS ru FROM worker_leases
      WHERE role = 'maker' AND runtime != 'manual' AND created_at >= ? AND created_at < ?`, since, until)) {
    const a = acc(leaseConsumer('maker', r.runtime, typeof r.model === 'string' ? r.model : null), 'maker');
    a.runs++; a.runIds.add(r.run);
    tokens(a, num(r.ta) ?? num(r.ru), r.runtime === 'remote');
  }

  for (const s of schedulers) { const a = acc(`scheduler:${s}`, 'scheduler'); a.otherRows++; }

  const byHost = new Map<string, Job[]>();
  for (const j of gpuJobs(db, since, until)) byHost.set(j.host, [...(byHost.get(j.host) ?? []), j]);
  const start = Date.parse(since); const end = Date.parse(until);
  for (const [host, jobs] of byHost) {
    const e = exclusiveWh(hostSamples(db, host, start, end + DAY), jobs);
    jobs.forEach((j, k) => {
      const a = out.get(energyOwner(j.consumer));
      if (!a) return; // a GPU consumer outside the catalogue (no lease, judgment, call or scheduler seen)
      a.gpuS += Math.round((j.end - j.start) / 1000); a.coveredS += e[k].covered_s; a.wh += e[k].wh;
    });
  }
  return out;
}

/** Verified runs credited per consumer (outcome_credits kind maker / judgment) and which of them survived on main. */
function credits(db: Database, since: string, until: string, survivedRuns: Set<string>): { recorded: boolean; byConsumer: Map<string, { verified: number; survived: number }> } {
  const recorded = safeAll<{ n: number }>(db, "SELECT COUNT(*) AS n FROM judgments WHERE judgment = 'outcome_attribution' AND created_at >= ? AND created_at < ?", since, until)[0]?.n > 0;
  const byConsumer = new Map<string, { verified: number; survived: number }>();
  const seen = new Set<string>();
  for (const c of safeAll<{ run_id: string; kind: string; ref: string }>(db,
    "SELECT run_id, kind, ref FROM outcome_credits WHERE kind IN ('maker', 'judgment') AND created_at >= ? AND created_at < ?", since, until)) {
    const key = `${c.kind}:${c.ref}`;
    if (seen.has(`${key}|${c.run_id}`)) continue;
    seen.add(`${key}|${c.run_id}`);
    const v = byConsumer.get(key) ?? { verified: 0, survived: 0 };
    v.verified++; if (survivedRuns.has(c.run_id)) v.survived++;
    byConsumer.set(key, v);
  }
  return { recorded, byConsumer };
}

export function consumerStatus(a: Acc): ConsumerStatus {
  if (a.enforceConsumed > 0) return 'decision_consumed';
  if (a.kind === 'maker') return 'consumed'; // a maker's change goes through the gates and to a PR
  if (a.runs > 0 && a.shadowRows === a.runs) return 'no_consumer';
  return 'unknown';
}

function windowStats(a: Acc, status: ConsumerStatus, windowDays: number, credit: { recorded: boolean; v: { verified: number; survived: number } | undefined }): WindowStats {
  const calls = a.known + a.unknown;
  const coverage = calls ? +(a.known / calls).toFixed(3) : null;
  const basis: WindowStats['tokens']['basis'] = calls ? 'reported' : a.noModel > 0 ? 'no_model_call' : 'not_recorded';
  const tokens = {
    cloud: basis === 'no_model_call' ? 0 : a.known > 0 ? a.cloud : null,
    local: basis === 'no_model_call' ? 0 : a.known > 0 ? a.local : null,
    known_calls: a.known, unknown_calls: a.unknown, coverage, basis,
  };
  const cov = a.gpuS > 0 ? a.coveredS / a.gpuS : null;
  const energy: WindowStats['energy'] = { gpu_seconds: a.gpuS,
    status: cov === null ? 'no_local_jobs' : cov >= 0.9 ? 'measured' : cov > 0 ? 'partial' : 'not_measured',
    wh: cov !== null && cov >= 0.9 ? +a.wh.toFixed(3) : null };
  const n = a.kind === 'maker' ? a.runIds.size : a.runs;

  let value: WindowStats['value'];
  if (status === 'no_consumer') value = { verified: 0, survived: 0, units: 0, decision_consumed: 0, basis: 'no_consumer (by design: shadow output nobody reads)' };
  // creditedContributors credits a judgment only when it gated the run in enforce mode: any other judgment has no credit path
  else if (credit.recorded && (a.kind === 'maker' || status === 'decision_consumed')) {
    const v = credit.v ?? { verified: 0, survived: 0 };
    value = { verified: v.verified, survived: v.survived, units: v.verified * VALUE_WEIGHTS.verified + v.survived * VALUE_WEIGHTS.survived,
      decision_consumed: a.kind === 'judgment' ? a.enforceConsumed : null, basis: 'outcome_credits' };
  } else if (status === 'decision_consumed') value = { verified: null, survived: null, units: null, decision_consumed: a.enforceConsumed, basis: 'decision_consumed' };
  else value = { verified: null, survived: null, units: null, decision_consumed: a.kind === 'judgment' ? a.enforceConsumed : null,
    basis: a.kind === 'maker' ? 'unknown: no outcome attribution recorded in the window'
      : a.kind === 'judgment' ? 'unknown: only enforce-mode judgments are credited' : 'unknown: no attribution path for this consumer kind' };

  const cloudKnown = tokens.cloud !== null && tokens.cloud > 0 && (coverage ?? 0) >= MIN_TOKEN_COVERAGE;
  const per_m_tokens = value.verified !== null && cloudKnown ? valuePer(value.verified, n, tokens.cloud! / 1e6) : null;
  const per_kwh = value.verified !== null && energy.wh ? valuePer(value.verified, n, energy.wh / 1000) : null;

  const costKnown = basis === 'no_model_call' || (calls > 0 && (coverage ?? 0) >= MIN_TOKEN_COVERAGE) || energy.status === 'measured';
  let cls: ValueClass; let reason: string;
  if (status === 'no_consumer') { cls = 'NO_CONSUMER'; reason = 'only shadow output: no gate, learner or operator reads it'; }
  else if (!costKnown) {
    cls = 'UNKNOWN_COST';
    reason = calls ? `token count reported for ${a.known}/${calls} calls (< ${MIN_TOKEN_COVERAGE * 100} %)` : 'no per-consumer token or energy record';
  } else if (status === 'decision_consumed') {
    cls = 'VALUE_PROVEN'; reason = `${a.enforceConsumed} decision(s) read by a gate in enforce mode${value.verified ? `; ${value.verified} credited verified run(s)` : ''}`;
  }
  else if (value.units === null) { cls = 'INSUFFICIENT'; reason = value.basis; }
  else if (value.units > 0 && n >= MIN_PROVEN_N) { cls = 'VALUE_PROVEN'; reason = `${value.verified} verified (${value.survived} survived) of ${n}`; }
  else if (value.units === 0 && n >= MIN_VOLUME) { cls = 'NO_VALUE'; reason = `0 credited verified runs over ${n} (≥ ${MIN_VOLUME})`; }
  else { cls = 'INSUFFICIENT'; reason = `n = ${n} (VALUE_PROVEN needs ≥ ${MIN_PROVEN_N} with value, NO_VALUE ≥ ${MIN_VOLUME} without)`; }
  return { window_days: windowDays, runs: n, tokens, energy, value, per_m_tokens, per_kwh, class: cls, reason };
}

/**
 * The shadow proposal for one consumer. share = proposed fraction of current volume (1 = unchanged). Hard floors are always
 * 'keep' at ≥ 1; VALUE_PROVEN and INSUFFICIENT never go below EXPLORATION_FLOOR. `peerMedian` = median verified per M tokens
 * over the VALUE_PROVEN consumers (null when fewer than two have one).
 */
export function proposeAction(r: { consumer_status: ConsumerStatus; hard_floor: string | null; w7: Pick<WindowStats, 'class' | 'per_m_tokens' | 'tokens' | 'energy'> },
  peerMedian: number | null): AllocationRow['proposal'] {
  const { w7 } = r;
  let p: AllocationRow['proposal'];
  const measuredCost = (w7.tokens.cloud ?? 0) + (w7.tokens.local ?? 0) > 0 || (w7.energy.wh ?? 0) > 0;
  switch (w7.class) {
    case 'NO_CONSUMER': p = measuredCost ? { action: 'pause', share: 0, reason: 'measured cost, output read by nobody' } : { action: 'keep', share: 1, reason: 'no consumer, but no measured cost to reclaim' }; break;
    case 'NO_VALUE': p = measuredCost ? { action: 'reduce_cap', share: 0.25, reason: 'enough volume, zero credited value' } : { action: 'keep', share: 1, reason: 'zero credited value, but no measured cost to reclaim' }; break;
    case 'UNKNOWN_COST': p = { action: 'keep', share: 1, reason: 'cost unknown: nothing to weigh' }; break;
    case 'INSUFFICIENT': p = { action: 'keep', share: 1, reason: 'insufficient evidence: keep exploring' }; break;
    default: {
      const v = w7.per_m_tokens;
      if (!v || peerMedian === null || peerMedian <= 0) p = { action: 'keep', share: 1, reason: 'value proven; no peer comparison per M tokens' };
      else if ((v.low ?? v.value) > peerMedian) p = { action: 'raise_share', share: 1.25, reason: `value per M tokens ${v.value} above the peer median ${peerMedian}` };
      else if (v.high !== null && v.high < peerMedian) p = { action: 'reduce_cap', share: +(v.high / peerMedian).toFixed(3), reason: `value per M tokens (upper ${v.high}) below the peer median ${peerMedian}` };
      else p = { action: 'keep', share: 1, reason: 'value proven, interval overlaps the peer median' };
    }
  }
  if ((w7.class === 'VALUE_PROVEN' || w7.class === 'INSUFFICIENT') && p.share < EXPLORATION_FLOOR) p = { ...p, share: EXPLORATION_FLOOR, reason: `${p.reason}; exploration floor ${EXPLORATION_FLOOR * 100} %` };
  if (r.hard_floor && (p.action === 'reduce_cap' || p.action === 'pause' || p.share < 1)) p = { action: 'keep', share: 1, reason: `hard floor (${r.hard_floor}): never reduced` };
  return p;
}

const median = (xs: number[]): number | null => {
  if (xs.length < 2) return null;
  const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return +(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2).toFixed(4);
};

export function buildValueAllocation(db: Database, now = Date.now(), env: NodeJS.ProcessEnv = process.env, schedulerNames?: string[]): ValueAllocation {
  const until = new Date(now).toISOString();
  const since7 = new Date(now - 7 * DAY).toISOString(); const since30 = new Date(now - 30 * DAY).toISOString();
  const scheds = schedulerNames ?? listSchedulers(now).schedulers.filter((s) => s.armed || s.last_run).map((s) => s.name);
  let survived = new Set<string>();
  try { survived = new Set(loopPrSettlements(db, now, undefined, env).filter((p) => p.settlement.state === 'SETTLED_SURVIVED').map((p) => p.run_id)); } catch { /* loop_runs absent */ }
  const a7 = collect(db, since7, until, scheds); const a30 = collect(db, since30, until, scheds);
  const c7 = credits(db, since7, until, survived); const c30 = credits(db, since30, until, survived);

  const rows = [...a7.entries()].map(([consumer, acc]) => {
    const status = consumerStatus(acc);
    const acc30 = a30.get(consumer) ?? acc;
    return { consumer, kind: acc.kind, consumer_status: status, hard_floor: hardFloor(consumer, status),
      w7: windowStats(acc, status, 7, { recorded: c7.recorded, v: c7.byConsumer.get(consumer) }),
      w30: windowStats(acc30, consumerStatus(acc30), 30, { recorded: c30.recorded, v: c30.byConsumer.get(consumer) }) };
  });
  const peer = median(rows.filter((r) => r.w7.class === 'VALUE_PROVEN' && r.w7.per_m_tokens).map((r) => r.w7.per_m_tokens!.value));
  const consumers: AllocationRow[] = rows.map((r) => ({ ...r, proposal: proposeAction(r, peer) }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.consumer.localeCompare(b.consumer));
  const by_class: Record<ValueClass, number> = { VALUE_PROVEN: 0, NO_VALUE: 0, NO_CONSUMER: 0, INSUFFICIENT: 0, UNKNOWN_COST: 0 };
  const by_action: Record<ProposedAction, number> = { keep: 0, reduce_cap: 0, pause: 0, raise_share: 0 };
  for (const c of consumers) { by_class[c.w7.class]++; by_action[c.proposal.action]++; }
  return {
    at: until, mode: valueAllocatorMode(env), attribution_recorded: { w7: c7.recorded, w30: c30.recorded }, by_class, by_action, consumers,
    notes: [
      'SHADOW: proposals are never applied; class and proposal come from the 7-day window, the 30-day window is context.',
      'NULL token counts are unknown, never 0; energy without ≥ 90 % sampled job time is unknown (null).',
      `value units = verified × ${VALUE_WEIGHTS.verified} + survived on main × ${VALUE_WEIGHTS.survived} (outcome_credits; fitness-view weights). NO_CONSUMER = 0 by design, not unknown.`,
      'Schedulers come from this process\'s registry (rebuilt at boot); per-scheduler tokens are not recorded, so most are UNKNOWN_COST.',
      `Hard floors (gates, security checker, safety, human merge, auth/deploy/secrets, merge survival, stall watch) are never proposed for reduction; VALUE_PROVEN / INSUFFICIENT never below ${EXPLORATION_FLOOR * 100} %.`,
    ],
  };
}

/** One `value_allocation` shadow judgment per UTC day (deduped on subject id). Returns the row id, or null when off. */
export function runValueAllocation(db: Database, now = Date.now(), env: NodeJS.ProcessEnv = process.env, schedulerNames?: string[]): string | null {
  if (valueAllocatorMode(env) === 'off') return null;
  const subject = `value-allocation:${new Date(now).toISOString().slice(0, 10)}`;
  const existing = db.prepare("SELECT id FROM judgments WHERE judgment = 'value_allocation' AND subject_id = ? LIMIT 1").get(subject) as { id: string } | undefined;
  if (existing) return existing.id;
  const v = buildValueAllocation(db, now, env, schedulerNames);
  const answers = JSON.stringify(v);
  const hash = createHash('sha256').update(answers).digest('hex');
  const id = `${subject}:${hash.slice(0, 12)}`;
  insertJudgmentRow(db, { id, judgment: 'value_allocation', subject_type: 'value_allocation', subject_id: subject, state_hash: hash, mode: 'shadow', decision: 'recorded',
    reason: `shadow allocation: ${Object.entries(v.by_class).map(([k, n]) => `${k} ${n}`).join(', ')}`.slice(0, 300), answers_json: answers, created_at: new Date(now).toISOString() });
  return id;
}

export function latestValueAllocation(db: Database): { id: string; created_at: string } | null {
  try { return (db.prepare("SELECT id, created_at FROM judgments WHERE judgment = 'value_allocation' ORDER BY created_at DESC LIMIT 1").get() as { id: string; created_at: string } | undefined) ?? null; }
  catch { return null; }
}

export function startValueAllocator(db: Database, intervalMs = 6 * 3_600_000, env: NodeJS.ProcessEnv = process.env): (() => void) | null {
  if (valueAllocatorMode(env) === 'off') return null;
  const tick = () => {
    markRun('value_allocator');
    try { runValueAllocation(db, Date.now(), env); } catch (e) { markRun('value_allocator', e); console.warn('value allocation failed:', e instanceof Error ? e.message : String(e)); }
  };
  tick(); const timer = setInterval(tick, intervalMs); timer.unref?.();
  return () => clearInterval(timer);
}
