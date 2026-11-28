import type { Database } from 'better-sqlite3';

/**
 * MAKER_FORECAST_MODE=off|shadow (default off). In shadow a goal-run maker is asked, in one line added to its prompt (not
 * to LOOP_WORK.md, so the assignment receipt is unchanged), to end with `FORECAST: <0-1>`: its own probability that the
 * change passes every check and the reviewer. It is stored on the lease (metadata.self_forecast) and scored by
 * makerForecastScore (evolution-evidence `maker_forecast`). Not a `forecast:` judgment: forecast-scoring drops any forecast
 * made after the goal exists as leakage, and a maker only exists after it. Nothing reads it to decide anything. The extra line IS a change to what the maker sees: switch it on only between experiments.
 */
export const makerForecastMode = (env: NodeJS.ProcessEnv = process.env): 'off' | 'shadow' => (env.MAKER_FORECAST_MODE === 'shadow' ? 'shadow' : 'off');

export const FORECAST_REQUEST = '\n\nWhen you are done, end your final message with exactly one line `FORECAST: <number between 0 and 1>`: your honest probability that this change passes every deterministic check and the independent reviewer. It is only recorded and scored for calibration; it never affects whether the change is accepted.\n';

/** The last `FORECAST: p` in the runtime output, or null when absent or outside [0, 1] (no forecast is not a forecast of 0). */
export function parseForecast(stdout: string): number | null {
  const all = [...stdout.matchAll(/FORECAST:\s*([01](?:\.\d+)?)(?![\d.])/g)];
  const p = all.length ? Number(all[all.length - 1][1]) : NaN;
  return Number.isFinite(p) && p >= 0 && p <= 1 ? p : null;
}

export interface MakerForecastScore { window_days: number; n: number; positives: number; unresolved: number; brier: number | null; base_rate: number | null; baseline_brier: number | null; skill: number | null; note: string }

/**
 * Scores the stored forecasts (lease metadata.self_forecast) against what the maker was asked about. Outcome per maker lease:
 * 0 when a deterministic check failed without timing out; else 1 / 0 by the verdict of its completed reviewer (accepted or
 * not); else unresolved (still running, a timed-out check, no parsed verdict) and not scored. Everything is null at n = 0.
 * ponytail: the baseline is the in-sample pass rate (hindsight); use a trailing rate before any decision rests on skill.
 */
export function makerForecastScore(db: Database, sinceDays = 60): MakerForecastScore {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const pairs: Array<[number, number]> = []; let unresolved = 0;
  try { // fail-soft on an empty or partial schema, like every evidence section
    const makers = db.prepare(`SELECT id, metadata FROM worker_leases WHERE role = 'maker' AND created_at >= ? AND json_extract(metadata, '$.self_forecast') IS NOT NULL`).all(since) as Array<{ id: string; metadata: string }>;
    const reviewer = db.prepare(`SELECT json_extract(metadata, '$.verdict') AS verdict FROM worker_leases WHERE role = 'checker' AND status = 'completed'
      AND json_extract(metadata, '$.maker_lease_id') = ? AND COALESCE(json_extract(metadata, '$.verdict_parsed'), 1) = 1 ORDER BY created_at DESC LIMIT 1`);
    for (const m of makers) {
      const meta = JSON.parse(m.metadata) as { self_forecast: number; deterministic_checks?: Array<{ status?: string; timed_out?: boolean }> };
      const failed = (meta.deterministic_checks ?? []).filter((c) => c.status === 'fail');
      const verdict = (reviewer.get(m.id) as { verdict: string | null } | undefined)?.verdict;
      const outcome = failed.some((c) => !c.timed_out) ? 0 : failed.length ? null : verdict ? (verdict === 'accepted' ? 1 : 0) : null;
      if (outcome === null) unresolved += 1; else pairs.push([meta.self_forecast, outcome]);
    }
  } catch { /* no table yet: n = 0 */ }
  const n = pairs.length; const positives = pairs.filter(([, o]) => o).length;
  const mean = (f: (pair: [number, number]) => number) => +(pairs.reduce((sum, pair) => sum + f(pair), 0) / n).toFixed(4);
  const base = n ? positives / n : null;
  const brier = n ? mean(([p, o]) => (p - o) ** 2) : null; const baseline = base === null ? null : mean(([, o]) => (base - o) ** 2);
  return { window_days: sinceDays, n, positives, unresolved, brier, base_rate: base === null ? null : +base.toFixed(4), baseline_brier: baseline,
    skill: brier !== null && baseline ? +(1 - brier / baseline).toFixed(4) : null,
    note: 'self_forecast of goal-run makers (MAKER_FORECAST_MODE=shadow) vs. checks + reviewer verdict; skill = 1 - brier / baseline_brier (in-sample pass rate), null when not computable; shadow only' };
}
