import type { Database } from 'better-sqlite3';
import { auc, forecastOf } from './forecast-scoring';

/**
 * Read-only: forecasts scored on the question "this proposal ends verified, given it got a goal". forecast-scoring (V1/V2)
 * drops every forecast made after the goal exists, because the panel's decision is then known; for the committee that
 * removed 120 of 134 forecast proposals (prod 2026-11-23), since a gap_analysis proposal gets its goal at once. Here a
 * forecast counts when it was WRITTEN before the proposal resolved (self_improvements.updated_at, as V2 uses) and the
 * proposal resolved verified / applied (1) or regressed (0). First forecast per forecaster and proposal. Below min_n every
 * metric is null. ponytail: in-sample base rate and no interval — evidence to look at, not to decide on; V1 is untouched.
 */
export interface PostGoalScore { forecaster: string; n: number; positives: number; base_rate: number | null; brier: number | null; baseline_brier: number | null; skill: number | null; auc: number | null }
export const POST_GOAL_MIN_N = 20;

export function postGoalForecastScores(db: Database, now = Date.now(), sinceDays = 90) {
  const since = new Date(now - sinceDays * 86_400_000).toISOString();
  const note = 'P(verified | goal): forecasts written before the proposal resolved, outcomes verified/applied vs regressed; skill = 1 - brier / baseline_brier (in-sample base rate of the same rows); null below min_n';
  let rows: Array<{ judgment: string; sid: string; answers: string | null; at: string; status: string; resolved_at: string }> = [];
  try {
    rows = db.prepare(`SELECT j.judgment, j.subject_id AS sid, j.answers_json AS answers, j.created_at AS at, s.status, s.updated_at AS resolved_at
      FROM judgments j JOIN self_improvements s ON s.id = j.subject_id
      WHERE j.subject_type = 'self_improvement' AND j.judgment LIKE 'forecast:%' AND j.decision <> 'error' AND j.created_at >= ?
        AND s.status IN ('verified', 'applied', 'regressed') ORDER BY j.created_at`).all(since) as typeof rows;
  } catch { /* no table yet: nothing scored */ }
  const pairs = new Map<string, Array<[number, number]>>(); const seen = new Set<string>(); let late = 0;
  for (const r of rows) {
    let answers: Record<string, unknown> = {}; try { answers = JSON.parse(r.answers || '{}'); } catch { continue; }
    const p = forecastOf(r.judgment, answers as never); if (p === null) continue;
    if (r.at >= r.resolved_at) { late++; continue; } // written after the outcome: not a forecast
    const key = `${r.judgment}|${r.sid}`; if (seen.has(key)) continue; seen.add(key);
    pairs.set(r.judgment, [...(pairs.get(r.judgment) ?? []), [p, r.status === 'regressed' ? 0 : 1]]);
  }
  const r4 = (v: number) => +v.toFixed(4);
  const forecasters: PostGoalScore[] = [...pairs.entries()].map(([forecaster, xs]) => {
    const n = xs.length; const positives = xs.filter(([, o]) => o).length;
    if (n < POST_GOAL_MIN_N) return { forecaster, n, positives, base_rate: null, brier: null, baseline_brier: null, skill: null, auc: null };
    const base = positives / n; const brier = xs.reduce((a, [p, o]) => a + (p - o) ** 2, 0) / n; const b0 = base * (1 - base);
    return { forecaster, n, positives, base_rate: r4(base), brier: r4(brier), baseline_brier: r4(b0), skill: b0 > 0 ? r4(1 - brier / b0) : null, auc: auc(xs) };
  }).sort((a, b) => (b.skill ?? -Infinity) - (a.skill ?? -Infinity) || b.n - a.n);
  return { window_days: sinceDays, min_n: POST_GOAL_MIN_N, forecasters, written_after_resolution: late, note };
}
