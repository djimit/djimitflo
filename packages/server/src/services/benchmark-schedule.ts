import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { Stall } from './stall-watch';
import { realRunIdSql } from './synthetic-runs';

/**
 * Periodic fixed benchmarks (operator 2026-11-07): an intelligence regression (a model, prompt, runtime or config change that
 * makes the reviewers or makers worse) must become an alarm, not something found by hand weeks later. Three fixed series:
 *  - sec-f1      the security checker on the 46 SEC-F1 items (docs/research/eco/SEC-F1_*.md), monthly on the 1st 02:00Z
 *  - f1          the checker on the 40 F1-R items (docs/research/eco/f1, scripts/f1-build-items.mjs), monthly on the 1st 02:00Z
 *  - gym-holdout a readout of the frozen gym holdout (no new attempts), weekly on Monday 03:00Z
 * The reviewer benchmarks need throwaway checkouts of upstream repos and a real opencode run, so they never run in the prod
 * container: when one is due and no real lease runs, the stall watch raises `benchmark:due:<id>` with the one-command operator
 * runner (scripts/benchmark-run.sh, throwaway containers on the prod image, the prod checker prompt and OpenCodeExecutor,
 * hard token cap, abort when a real lease starts); its result comes back through dist/scripts/benchmark-cli.js ingest, which
 * writes benchmark_runs only. The gym readout is a read-only query and runs in-process (benchmark-runner.ts: the readout, the tick
 * and the scheduler; kept apart so the stall watch and the evidence endpoint never load the gym / dream modules).
 * Alarms (stall watch): `benchmark:regression:<id>` (the latest ok value fell below the previous ok value on the same item set by
 * more than max(the previous run's CI half-width below its value, BENCHMARK_REGRESSION_MARGIN)), `benchmark:overdue:<id>`
 * (no closing run more than 7 days after the slot it owed).
 * BENCHMARK_SCHEDULE_MODE off (default: no runs, no alarms) | on. A measurement flag, not a treatment variable: it changes no
 * maker, checker, panel or gate input.
 */
export type BenchmarkScheduleMode = 'off' | 'on';
export const benchmarkScheduleMode = (env: NodeJS.ProcessEnv = process.env): BenchmarkScheduleMode => (env.BENCHMARK_SCHEDULE_MODE === 'on' ? 'on' : 'off');

export type BenchmarkId = 'sec-f1' | 'f1' | 'gym-holdout';
export type Cadence = 'monthly' | 'weekly';
export type BenchmarkStatus = 'ok' | 'failed' | 'insufficient';
export interface BenchmarkDef {
  id: BenchmarkId; title: string; cadence: Cadence; metric: 'auc' | 'pass_rate';
  /** operator_runner: due → stall + one-command runner on the VPS host; in_process: the scheduler tick computes it */
  execution: 'operator_runner' | 'in_process';
  role?: 'security_checker' | 'checker'; items?: string;
}
export const BENCHMARKS: readonly BenchmarkDef[] = Object.freeze([
  { id: 'sec-f1', title: 'SEC-F1 security checker discrimination', cadence: 'monthly', metric: 'auc', execution: 'operator_runner', role: 'security_checker', items: 'docs/research/eco/sec-f1' },
  { id: 'f1', title: 'F1-R checker discrimination', cadence: 'monthly', metric: 'auc', execution: 'operator_runner', role: 'checker', items: 'docs/research/eco/f1' },
  { id: 'gym-holdout', title: 'Gym frozen holdout readout', cadence: 'weekly', metric: 'pass_rate', execution: 'in_process' },
]);
export const benchmarkDef = (id: string): BenchmarkDef | undefined => BENCHMARKS.find((b) => b.id === id);
export const runnerCommand = (id: BenchmarkId): string => `bash scripts/benchmark-run.sh ${id} --apply`;

export const DEFAULT_BENCHMARK_TOKEN_CAP = 6_000_000;
/** Hard cap per reviewer run (sum of opencode step totals); BENCHMARK_TOKEN_CAP, a positive integer, else 6 M. */
export function benchmarkTokenCap(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.BENCHMARK_TOKEN_CAP);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_BENCHMARK_TOKEN_CAP;
}
export const DEFAULT_REGRESSION_MARGIN = 0.05;
/** The minimum drop that alarms (AUC or pass-rate points); BENCHMARK_REGRESSION_MARGIN in (0, 1), else 0.05. */
export function regressionMargin(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.BENCHMARK_REGRESSION_MARGIN);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : DEFAULT_REGRESSION_MARGIN;
}
export const OVERDUE_DAYS = 7;
/** Below this many scored items a readout is 'insufficient' (it is stored, never compared). */
export const MIN_SCORED = 10;

const DAY = 86_400_000;
/** The latest scheduled slot at or before `t`: monthly the 1st 02:00Z, weekly Monday 03:00Z. */
export function latestSlot(cadence: Cadence, t: number): number {
  const d = new Date(t);
  if (cadence === 'monthly') {
    const s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 2);
    return s <= t ? s : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1, 2);
  }
  const s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7), 3);
  return s <= t ? s : s - 7 * DAY;
}
/** The first slot strictly after `t`. */
export function nextSlotAfter(cadence: Cadence, t: number): number {
  const s = latestSlot(cadence, t);
  if (cadence === 'weekly') return s + 7 * DAY;
  const d = new Date(s);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 2);
}

export interface BenchmarkRun {
  id: string; benchmark_id: string; slot: string | null; manifest_sha256: string | null; prompt_sha256: string | null; models: string[]; runtime: string | null;
  started_at: string; finished_at: string | null; tokens: number | null; metric: string; value: number | null; ci_low: number | null; ci_high: number | null;
  n: number; positives: number | null; negatives: number | null; catches: number | null; false_rejects: number | null; status: BenchmarkStatus; reason: string | null;
  source: string; detail: Record<string, unknown>;
}
type Row = Omit<BenchmarkRun, 'models' | 'detail'> & { models_json: string; detail_json: string };
const fromRow = (r: Row): BenchmarkRun => {
  const parse = <T>(s: string, d: T): T => { try { return JSON.parse(s) as T; } catch { return d; } };
  const { models_json, detail_json, ...rest } = r;
  return { ...rest, models: parse<string[]>(models_json, []), detail: parse<Record<string, unknown>>(detail_json, {}) };
};
const COLS = 'id, benchmark_id, slot, manifest_sha256, prompt_sha256, models_json, runtime, started_at, finished_at, tokens, metric, value, ci_low, ci_high, n, positives, negatives, catches, false_rejects, status, reason, source, detail_json';

/** Inserts one run (idempotent on id: a re-ingest or a second tick in the same slot writes nothing). Returns whether a row was written. */
export function recordBenchmarkRun(db: Database, run: BenchmarkRun, now = new Date().toISOString()): boolean {
  return db.prepare(`INSERT OR IGNORE INTO benchmark_runs (${COLS}, created_at) VALUES (${COLS.split(', ').map(() => '?').join(', ')}, ?)`).run(
    run.id, run.benchmark_id, run.slot, run.manifest_sha256, run.prompt_sha256, JSON.stringify(run.models), run.runtime, run.started_at, run.finished_at, run.tokens,
    run.metric, run.value, run.ci_low, run.ci_high, run.n, run.positives, run.negatives, run.catches, run.false_rejects, run.status, run.reason, run.source,
    JSON.stringify(run.detail), now).changes > 0;
}

export function benchmarkRuns(db: Database, id: string, limit = 24): BenchmarkRun[] {
  return (db.prepare(`SELECT ${COLS} FROM benchmark_runs WHERE benchmark_id = ? ORDER BY started_at DESC, created_at DESC LIMIT ?`).all(id, limit) as Row[]).map(fromRow);
}
/** ok and insufficient close a slot; a failed run (abort, harness fault) leaves it due. */
const CLOSING = "status IN ('ok', 'insufficient')";
const lastClosing = (db: Database, id: string): BenchmarkRun | null => {
  const r = db.prepare(`SELECT ${COLS} FROM benchmark_runs WHERE benchmark_id = ? AND ${CLOSING} ORDER BY started_at DESC LIMIT 1`).get(id) as Row | undefined;
  return r ? fromRow(r) : null;
};

export interface BenchmarkState { id: BenchmarkId; slot: string; due: boolean; owed_at: string; overdue: boolean; late_days: number | null; last: BenchmarkRun | null }
/**
 * Due: no closing run since the latest slot. Overdue: the slot owed after the last closing run (or, never run, the latest
 * slot) lies more than OVERDUE_DAYS in the past.
 */
export function benchmarkState(db: Database, def: BenchmarkDef, now = Date.now()): BenchmarkState {
  const slot = latestSlot(def.cadence, now);
  const last = lastClosing(db, def.id);
  const lastAt = last ? Date.parse(last.started_at) : null;
  const owed = lastAt === null ? slot : nextSlotAfter(def.cadence, lastAt);
  const due = lastAt === null || lastAt < slot;
  const overdue = due && now - owed > OVERDUE_DAYS * DAY;
  return { id: def.id, slot: new Date(slot).toISOString(), due, owed_at: new Date(owed).toISOString(), overdue,
    late_days: due ? +((now - owed) / DAY).toFixed(1) : null, last };
}

/** Running worker leases of real loop work (synthetic PR-review bookkeeping and gym / experiment replays excluded). */
export function realLeasesRunning(db: Database): Array<{ id: string; role: string; runtime: string; loop_run_id: string; created_at: string }> {
  return db.prepare(`SELECT l.id, l.role, l.runtime, l.loop_run_id, l.created_at FROM worker_leases l WHERE l.status = 'running' AND ${realRunIdSql('l.loop_run_id')}
    AND NOT EXISTS (SELECT 1 FROM loop_runs g WHERE g.id = l.loop_run_id AND g.loop_name IN ('evolution-gym', 'pl-001', 'tg-001')) ORDER BY l.created_at`).all() as Array<{ id: string; role: string; runtime: string; loop_run_id: string; created_at: string }>;
}

/** Hanley & McNeil (1982) 95 % interval of a Mann-Whitney AUC with `pos` positives and `neg` negatives; null when a side is empty. */
export function aucCi(auc: number | null, pos: number, neg: number, z = 1.96): [number, number] | null {
  if (auc === null || !Number.isFinite(auc) || pos <= 0 || neg <= 0) return null;
  const q1 = auc / (2 - auc); const q2 = (2 * auc * auc) / (1 + auc);
  const se = Math.sqrt(Math.max(0, (auc * (1 - auc) + (pos - 1) * (q1 - auc * auc) + (neg - 1) * (q2 - auc * auc)) / (pos * neg)));
  return [+Math.max(0, auc - z * se).toFixed(4), +Math.min(1, auc + z * se).toFixed(4)];
}

export interface Regression { regressed: boolean; drop: number | null; threshold: number | null; basis: 'ci' | 'margin' | null }
/**
 * The latest value fell below the previous one by more than max(the previous run's CI half-width below its value, margin).
 * Both runs must be ok and on the same item set (manifest sha); otherwise nothing is compared (regressed false, drop null).
 */
export function regressionCheck(prev: BenchmarkRun | null, cur: BenchmarkRun | null, margin = DEFAULT_REGRESSION_MARGIN): Regression {
  if (!prev || !cur || prev.status !== 'ok' || cur.status !== 'ok' || prev.value === null || cur.value === null) return { regressed: false, drop: null, threshold: null, basis: null };
  if (prev.manifest_sha256 !== cur.manifest_sha256) return { regressed: false, drop: null, threshold: null, basis: null };
  const ciDrop = prev.ci_low === null ? null : prev.value - prev.ci_low;
  const basis = ciDrop !== null && ciDrop > margin ? 'ci' : 'margin';
  const threshold = +Math.max(margin, ciDrop ?? 0).toFixed(4);
  const drop = +(prev.value - cur.value).toFixed(4);
  return { regressed: drop > threshold + 1e-9, drop, threshold, basis };
}

/** The two latest ok runs of a benchmark (newest first). */
export const lastTwoOk = (db: Database, id: string): BenchmarkRun[] =>
  (db.prepare(`SELECT ${COLS} FROM benchmark_runs WHERE benchmark_id = ? AND status = 'ok' ORDER BY started_at DESC, created_at DESC LIMIT 2`).all(id) as Row[]).map(fromRow);

const short = (s: string | null | undefined) => (s ? s.slice(0, 8) : 'none');
/** The stall watch's benchmark detectors: due (operator-run, idle host), overdue, regression. Empty when the flag is off. */
export function detectBenchmarkStalls(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()): Stall[] {
  if (benchmarkScheduleMode(env) === 'off') return [];
  const out: Stall[] = [];
  const busy = realLeasesRunning(db).length;
  const cap = benchmarkTokenCap(env);
  for (const def of BENCHMARKS) {
    const st = benchmarkState(db, def, now);
    const how = def.execution === 'operator_runner' ? `run \`${runnerCommand(def.id)}\` on the VPS host (token cap ${cap})` : 'the in-process readout did not record a run (check the benchmark_schedule scheduler)';
    if (st.overdue) out.push({ subsystem: `benchmark:overdue:${def.id}`, since: st.owed_at, detail: `${def.title}: the run owed at ${st.owed_at} is ${st.late_days} d late (last closing run ${st.last?.started_at ?? 'never'}); ${how}`.slice(0, 500) });
    else if (st.due && def.execution === 'operator_runner' && busy === 0) out.push({ subsystem: `benchmark:due:${def.id}`, since: st.slot, detail: `${def.title} is due (slot ${st.slot}) and no real lease runs: ${how}`.slice(0, 500) });
    const [cur, prev] = lastTwoOk(db, def.id);
    const r = regressionCheck(prev ?? null, cur ?? null, regressionMargin(env));
    if (r.regressed && cur && prev) {
      const changed = [prev.prompt_sha256 !== cur.prompt_sha256 ? `prompt ${short(prev.prompt_sha256)}→${short(cur.prompt_sha256)}` : null,
        prev.models.join(',') !== cur.models.join(',') ? `model ${prev.models.join(',') || 'unknown'}→${cur.models.join(',') || 'unknown'}` : null,
        prev.runtime !== cur.runtime ? `runtime ${prev.runtime ?? 'unknown'}→${cur.runtime ?? 'unknown'}` : null].filter(Boolean);
      out.push({ subsystem: `benchmark:regression:${def.id}`, since: cur.started_at,
        detail: `${def.title}: ${def.metric} ${prev.value} (${prev.started_at.slice(0, 10)}) → ${cur.value} (${cur.started_at.slice(0, 10)}), drop ${r.drop} > ${r.threshold} (${r.basis === 'ci' ? 'previous CI' : 'margin'}); ${changed.length ? `changed: ${changed.join('; ')}` : 'same prompt, model and runtime'}`.slice(0, 500) });
    }
  }
  return out;
}

export const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// ── reviewer runs (operator runner → benchmark-cli ingest) ────────────────────────────────────────────────────────────────

export interface ReviewerScore { all?: { items?: { scored_positives?: number; scored_negatives?: number; unscored?: number }; auc?: number | null;
  llm?: { caught?: { k?: number }; false_reject?: { k?: number } }; tokens?: { total?: number } }; manifest_sha256?: string; decision?: string }
export interface ReviewerResult { id?: string; verdict?: string; tokens_total?: number; effective_model?: string | null; checker_instructions_sha256?: string; started_at?: string; finished_at?: string; runtime?: string }
export interface ReviewerIngest { score: ReviewerScore | null; results: ReviewerResult[]; meta?: { cap?: number; started_at?: string; role?: string; opencode_version?: string | null } | null;
  abort?: { reason?: string; at?: string } | null; manifestSha256?: string | null; sourceSha?: string | null }

/**
 * Maps a reviewer benchmark's runner output (scorer JSON, results JSONL, run-meta, abort note) to one benchmark_runs row.
 * failed: aborted (a real lease started, recorded with its reason) or nothing scored; insufficient: some items unscored
 * (token cap or no verdict); ok otherwise. AUC CI: Hanley-McNeil on the scored items. Pure.
 */
export function reviewerRun(def: BenchmarkDef, input: ReviewerIngest): BenchmarkRun {
  const results = input.results ?? [];
  const all = input.score?.all;
  const pos = all?.items?.scored_positives ?? 0; const neg = all?.items?.scored_negatives ?? 0; const unscored = all?.items?.unscored ?? null;
  const tokens = results.reduce((s, r) => s + (Number(r.tokens_total) || 0), 0);
  const auc = typeof all?.auc === 'number' ? all.auc : null;
  const cap = Number(input.meta?.cap) || null;
  const started = [input.meta?.started_at, ...results.map((r) => r.started_at)].filter((t): t is string => typeof t === 'string').sort()[0] ?? input.abort?.at ?? new Date().toISOString();
  const finished = [...results.map((r) => r.finished_at), input.abort?.at].filter((t): t is string => typeof t === 'string').sort().pop() ?? null;
  const prompts = [...new Set(results.map((r) => r.checker_instructions_sha256).filter((p): p is string => typeof p === 'string'))].sort();
  const models = [...new Set(results.filter((r) => r.verdict).map((r) => r.effective_model || 'opencode-default'))].sort();
  let status: BenchmarkStatus; let reason: string | null = null;
  if (input.abort?.reason) { status = 'failed'; reason = `aborted: ${input.abort.reason}`.slice(0, 300); }
  else if (!input.score || auc === null || pos + neg === 0) { status = 'failed'; reason = 'no scored items (harness fault or nothing ran)'; }
  else if (unscored) { status = 'insufficient'; reason = `${unscored} item(s) unscored (${cap !== null && tokens >= cap ? `token cap ${cap} reached` : 'no verdict'})`; }
  else status = 'ok';
  const ci = aucCi(auc, pos, neg);
  const manifest = input.manifestSha256 ?? input.score?.manifest_sha256 ?? null;
  const id = `${def.id}:${sha(JSON.stringify([manifest, started, status, pos, neg, tokens])).slice(0, 16)}`;
  return { id, benchmark_id: def.id, slot: new Date(latestSlot(def.cadence, Date.parse(started) || Date.now())).toISOString(), manifest_sha256: manifest,
    prompt_sha256: prompts.join(',') || null, models, runtime: results.find((r) => r.runtime)?.runtime ?? 'opencode', started_at: started, finished_at: finished, tokens,
    metric: 'auc', value: auc, ci_low: ci?.[0] ?? null, ci_high: ci?.[1] ?? null, n: pos + neg, positives: pos, negatives: neg,
    catches: all?.llm?.caught?.k ?? null, false_rejects: all?.llm?.false_reject?.k ?? null, status, reason, source: 'operator_runner',
    detail: { role: input.meta?.role ?? def.role ?? null, cap, unscored, decision: input.score?.decision ?? null, opencode_version: input.meta?.opencode_version ?? null,
      source_sha: input.sourceSha ?? null, ...(input.abort ? { abort: input.abort } : {}) } };
}

/** The Evolution page series: per benchmark its state and its newest runs (oldest first), plus the regression verdict. */
export function benchmarkEvidence(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now(), limit = 12) {
  const mode = benchmarkScheduleMode(env);
  return { mode, token_cap: benchmarkTokenCap(env), margin: regressionMargin(env), benchmarks: BENCHMARKS.map((def) => {
    const runs = (() => { try { return benchmarkRuns(db, def.id, limit); } catch { return [] as BenchmarkRun[]; } })();
    const [cur, prev] = (() => { try { return lastTwoOk(db, def.id); } catch { return [] as BenchmarkRun[]; } })();
    const st = (() => { try { return benchmarkState(db, def, now); } catch { return null; } })();
    return { id: def.id, title: def.title, metric: def.metric, cadence: def.cadence, execution: def.execution,
      due: st?.due ?? null, overdue: st?.overdue ?? null, owed_at: st?.owed_at ?? null, regression: regressionCheck(prev ?? null, cur ?? null, regressionMargin(env)),
      series: runs.reverse().map((r) => ({ started_at: r.started_at, status: r.status, value: r.value, ci_low: r.ci_low, ci_high: r.ci_high, n: r.n, catches: r.catches,
        false_rejects: r.false_rejects, tokens: r.tokens, models: r.models, prompt_sha256: r.prompt_sha256, reason: r.reason })) };
  }) };
}
