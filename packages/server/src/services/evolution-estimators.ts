import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { buildEvolutionEvidence } from './evolution-evidence';
import { markRun } from './scheduler-registry';
import { irtSummary } from './gym-irt';

/**
 * RX-14 (Phase F): the nightly "thermometer". Once per UTC day the loop's own measurements are persisted to
 * evolution_estimates so trends exist (history cannot be backfilled). Every estimator is fail-soft and upserts one row
 * per (estimator, scope, day); n = 0 is 'insufficient' with no value, never 0. No heritability number (F4: undefined).
 * EVOLUTION_ESTIMATORS_ENABLED=true (default off). Read back by the evidence endpoint's 'estimates' section.
 */
export const estimatorsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.EVOLUTION_ESTIMATORS_ENABLED === 'true';

export interface Estimate { estimator: string; scope: string; window_days: number; value: number | null; ci_low: number | null; ci_high: number | null; n: number; detail?: Record<string, unknown> }

/** Nearest-rank quantile of an ascending-sorted list; null when empty. */
export function quantile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** Wilson 95 % interval for k successes in n. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 1];
  const p = k / n; const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d; const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [+Math.max(0, c - h).toFixed(4), +Math.min(1, c + h).toFixed(4)];
}

const delay = (estimator: string, scope: string, window_days: number, hours: number[]): Estimate => {
  const xs = hours.filter((h) => Number.isFinite(h) && h >= 0).sort((a, b) => a - b);
  const r1 = (v: number | null) => (v === null ? null : +v.toFixed(1));
  return { estimator, scope, window_days, value: r1(quantile(xs, 0.5)), ci_low: null, ci_high: null, n: xs.length,
    detail: { p50: r1(quantile(xs, 0.5)), p90: r1(quantile(xs, 0.9)), max: r1(quantile(xs, 1)) } };
};
const rate = (estimator: string, scope: string, window_days: number, k: number, n: number, detail?: Record<string, unknown>): Estimate => {
  const [lo, hi] = wilson(k, n);
  return { estimator, scope, window_days, value: n ? +(k / n).toFixed(4) : null, ci_low: n ? lo : null, ci_high: n ? hi : null, n, ...(detail ? { detail } : {}) };
};

export function computeEstimates(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()): Estimate[] {
  const all = <T>(sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } };
  const since = (d: number) => new Date(now - d * 86_400_000).toISOString();
  const out: Estimate[] = [];

  // signal delays: maker run → its skill outcome; PR open → merge; merge → merge-survival settlement
  out.push(delay('delay_run_to_outcome_h', 'loop', 30, all<{ h: number }>(`SELECT (julianday(o.created_at) - julianday(r.created_at)) * 24 AS h
    FROM skill_outcomes o JOIN loop_runs r ON r.id = o.task_id WHERE o.domain = 'loop' AND o.created_at >= ?`, since(30)).map((r) => r.h)));
  out.push(delay('delay_pr_open_to_merge_h', 'loop_pr', 60, all<{ h: number }>(`SELECT json_extract(metadata, '$.pr_outcome.review_latency_h') AS h FROM loop_runs
    WHERE json_extract(metadata, '$.pr_outcome.review_latency_h') IS NOT NULL AND created_at >= ?`, since(60)).map((r) => Number(r.h))));
  out.push(delay('delay_merge_to_settlement_h', 'loop_pr', 60, all<{ h: number }>(`SELECT (julianday(json_extract(metadata, '$.pr_outcome.settled_at')) - julianday(json_extract(metadata, '$.pr_outcome.merged_at'))) * 24 AS h
    FROM loop_runs WHERE json_extract(metadata, '$.pr_outcome.merged_at') IS NOT NULL AND json_extract(metadata, '$.pr_outcome.settled_at') IS NOT NULL AND created_at >= ?`, since(60)).map((r) => r.h)));

  // discriminability: gym tasks with ≥ 2 scored attempts in 14 d whose pass rate is strictly between 0 and 1
  const gymRuns = `FROM loop_runs WHERE loop_name = 'evolution-gym' AND created_at >= ? AND json_extract(metadata, '$.gym.canary') IS NULL
    AND json_extract(metadata, '$.gym_result.status') IN ('success', 'failure')`;
  const tasks = all<{ k: string; n: number; ok: number }>(`SELECT json_extract(metadata, '$.gym.commit') AS k, COUNT(*) AS n,
    SUM(json_extract(metadata, '$.gym_result.status') = 'success') AS ok ${gymRuns} GROUP BY 1 HAVING n >= 2`, since(14));
  const mixed = tasks.filter((t) => t.ok > 0 && t.ok < t.n).length;
  out.push(rate('discriminability', 'gym', 14, mixed, tasks.length,
    { unsolved_by_all: tasks.filter((t) => t.ok === 0).length, solved_by_all: tasks.filter((t) => t.ok === t.n).length }));

  // gym pass rate per mutant tier (probe and ordinary attempts; canaries excluded)
  for (const t of all<{ tier: number; n: number; ok: number }>(`SELECT json_extract(metadata, '$.gym.tier') AS tier, COUNT(*) AS n,
    SUM(json_extract(metadata, '$.gym_result.status') = 'success') AS ok ${gymRuns} AND json_extract(metadata, '$.gym.tier') IS NOT NULL GROUP BY 1`, since(14))) {
    out.push(rate('gym_pass_rate', `tier:${t.tier}`, 14, t.ok, t.n));
  }

  // trial blindness: share of settled trials (RX-4 diagnostics) that could not have promoted anything
  const trials = all<{ state: string; n: number }>('SELECT state, COUNT(*) AS n FROM genome_trial_results WHERE recorded_at >= ? GROUP BY 1', since(30));
  const tn = trials.reduce((a, t) => a + t.n, 0);
  out.push(rate('trial_blindness', 'trials', 30, trials.find((t) => t.state === 'blind')?.n ?? 0, tn, Object.fromEntries(trials.map((t) => [t.state, t.n]))));

  // model selector: usable-answer rate per consumer × model (agreement in detail)
  for (const m of all<{ consumer: string; model: string; n: number; ok: number; compared: number; agreed: number }>(`SELECT consumer, model, COUNT(*) AS n, SUM(ok) AS ok,
    SUM(agree IS NOT NULL) AS compared, SUM(COALESCE(agree, 0)) AS agreed FROM llm_model_calls WHERE created_at >= ? GROUP BY 1, 2`, since(14))) {
    out.push(rate('model_ok_rate', `${m.consumer}|${m.model}`, 14, m.ok, m.n, { compared: m.compared, agreed: m.agreed, agree_rate: m.compared ? +(m.agreed / m.compared).toFixed(4) : null }));
  }

  // B8: IRT calibration of the gym — share of tasks that discriminate (2PL a ≥ 0.3, mixed outcomes) and the most informative
  // tasks at the evolving species' baseline ability (detail); per-flag counts let the trend show whether the task pool improves
  try {
    const irt = irtSummary(db, env);
    out.push(rate('gym_irt_discriminating', 'gym', 0, irt.counts.ok, irt.items - irt.counts.insufficient,
      { counts: irt.counts, parent: irt.parent, theta: irt.theta, top: irt.top }));
  } catch { /* fail-soft */ }

  // Realm Gates A–D as computed today (value 1 green / 0 red / null unknown; the reason in detail)
  try {
    for (const [g, gate] of Object.entries(buildEvolutionEvidence(db, env, now).gates)) {
      out.push({ estimator: 'gate', scope: g, window_days: 30, value: gate.state === 'green' ? 1 : gate.state === 'red' ? 0 : null, ci_low: null, ci_high: null, n: 1, detail: { state: gate.state, reason: gate.reason } });
    }
  } catch { /* evidence fail-soft */ }
  return out;
}

/** Computes and upserts today's estimates; returns how many rows were written. */
export function runEstimators(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()): number {
  const day = new Date(now).toISOString().slice(0, 10); const at = new Date(now).toISOString();
  const upsert = db.prepare(`INSERT INTO evolution_estimates (id, estimator, scope, as_of_day, window_days, value, ci_low, ci_high, n, status, detail_json, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(estimator, scope, as_of_day) DO UPDATE SET window_days = excluded.window_days, value = excluded.value, ci_low = excluded.ci_low,
      ci_high = excluded.ci_high, n = excluded.n, status = excluded.status, detail_json = excluded.detail_json, computed_at = excluded.computed_at`);
  const rows = computeEstimates(db, env, now);
  db.transaction(() => {
    for (const e of rows) {
      const status = e.n > 0 ? 'ok' : 'insufficient';
      upsert.run(randomUUID(), e.estimator, e.scope, day, e.window_days, status === 'ok' ? e.value : null, e.ci_low, e.ci_high, e.n, status, JSON.stringify(e.detail ?? {}), at);
    }
  })();
  return rows.length;
}

/** Hourly tick that writes one set of estimates per UTC day; null when the flag is off. */
export function startEvolutionEstimators(db: Database, intervalMs = 3_600_000, env: NodeJS.ProcessEnv = process.env, clock = () => Date.now()): (() => void) | null {
  if (!estimatorsEnabled(env)) return null;
  const tick = () => {
    try {
      const now = clock(); const day = new Date(now).toISOString().slice(0, 10);
      if (db.prepare('SELECT 1 FROM evolution_estimates WHERE as_of_day = ? LIMIT 1').get(day)) return;
      const n = runEstimators(db, env, now);
      markRun('evolution_estimators');
      console.log(`🌡️  evolution estimates: ${n} row(s) for ${day}`);
    } catch (e) { markRun('evolution_estimators', e); console.warn('evolution estimates failed:', e instanceof Error ? e.message : String(e)); }
  };
  tick(); const timer = setInterval(tick, intervalMs); timer.unref?.();
  return () => clearInterval(timer);
}
