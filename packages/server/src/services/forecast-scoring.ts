import type { Database } from 'better-sqlite3';

/**
 * Plan AR1 (Agent Commons → arena): every agent that claims to judge proposals is scored as a forecaster of the oracle
 * outcome "this proposal ends verified". Backfill 2026-10-02 (870 resolved proposals, 13 verified): no forecaster beat the
 * per-source base rate — jev prescreen Brier 0.41 vs 0.11, residents AUC 0.25 (anti-predictive); the panel's AUC 0.98 is
 * leakage (goals only exist when the panel says goal). Rules this module enforces:
 *  - only forecasts recorded BEFORE the proposal's goal was created count (no leakage from gates or outcomes);
 *  - skill is measured against the per-source base rate (what a forecaster must beat), never against 0.5.
 * Forecasts are `judgments` rows: the existing jev prescreen (P = product of its Noul answers) and any `forecast:<agent>`
 * row whose answers_json holds {"p": number}. Read-only; nothing is gated on it yet.
 */
export interface ForecasterScore { forecaster: string; n: number; positives: number; brier: number; baselineBrier: number; skill: number; auc: number | null }

const VERIFIED = new Set(['verified', 'applied']);
const RESOLVED = ['verified', 'applied', 'regressed', 'no_change', 'infra_failed', 'needs_more_evidence', 'archived'];

export function auc(pairs: Array<[number, number]>): number | null {
  const pos = pairs.filter(([, o]) => o === 1).map(([p]) => p); const neg = pairs.filter(([, o]) => o === 0).map(([p]) => p);
  if (!pos.length || !neg.length) return null;
  let s = 0; for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0;
  return s / (pos.length * neg.length);
}

const brier = (pairs: Array<[number, number]>): number => pairs.reduce((a, [p, o]) => a + (p - o) ** 2, 0) / pairs.length;

/** The forecast a judgments row carries, or null when it is not a probability of success. */
export function forecastOf(judgment: string, answers: Record<string, { noul?: number }> & { p?: number }): number | null {
  if (judgment === 'proposal_prescreen') {
    const v = ['verifiable', 'concrete', 'names_file'].map((k) => answers[k]?.noul).filter((x): x is number => typeof x === 'number');
    return v.length ? v.reduce((a, b) => a * b, 1) : null;
  }
  return judgment.startsWith('forecast:') && typeof answers.p === 'number' && answers.p >= 0 && answers.p <= 1 ? answers.p : null;
}

export function forecastScores(db: Database, sinceDays = 60): ForecasterScore[] {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const props = db.prepare(`SELECT s.id, s.source, s.status, (SELECT MIN(g.created_at) FROM goals g WHERE g.improvement_id = s.id) AS goal_at
    FROM self_improvements s WHERE s.created_at >= ? AND s.status IN (${RESOLVED.map(() => '?').join(',')})`).all(since, ...RESOLVED) as Array<{ id: string; source: string; status: string; goal_at: string | null }>;
  if (!props.length) return [];
  const outcome = (s: string) => (VERIFIED.has(s) ? 1 : 0);
  const rate: Record<string, number> = {};
  for (const src of new Set(props.map((p) => p.source))) { const xs = props.filter((p) => p.source === src); rate[src] = xs.reduce((a, p) => a + outcome(p.status), 0) / xs.length; }
  const byId = new Map(props.map((p) => [p.id, p]));
  const rows = db.prepare(`SELECT judgment, subject_id, answers_json, created_at FROM judgments
    WHERE subject_type = 'self_improvement' AND decision <> 'error' AND (judgment = 'proposal_prescreen' OR judgment LIKE 'forecast:%') AND created_at >= ?`).all(since) as Array<{ judgment: string; subject_id: string; answers_json: string | null; created_at: string }>;
  const pairs = new Map<string, Array<[number, number, string]>>(); // forecaster → [p, outcome, source]
  const seen = new Set<string>();
  for (const r of rows) {
    const prop = byId.get(r.subject_id); if (!prop) continue;
    if (prop.goal_at && r.created_at >= prop.goal_at) continue; // after the gate decided: leakage
    const key = `${r.judgment}|${r.subject_id}`; if (seen.has(key)) continue; seen.add(key); // first forecast per subject only
    let answers = {}; try { answers = JSON.parse(r.answers_json || '{}'); } catch { /* unparsable: skip */ }
    const p = forecastOf(r.judgment, answers as never); if (p === null) continue;
    const list = pairs.get(r.judgment) ?? []; list.push([p, outcome(prop.status), prop.source]); pairs.set(r.judgment, list);
  }
  const score = (name: string, list: Array<[number, number, string]>): ForecasterScore => {
    const b = brier(list.map(([p, o]) => [p, o])); const base = brier(list.map(([, o, s]) => [rate[s], o]));
    return { forecaster: name, n: list.length, positives: list.filter(([, o]) => o).length, brier: b, baselineBrier: base, skill: base > 0 ? 1 - b / base : 0, auc: auc(list.map(([p, o]) => [p, o])) };
  };
  const all = props.map((p) => [rate[p.source], outcome(p.status), p.source] as [number, number, string]);
  return [score('baseline:source_rate', all), ...[...pairs.entries()].map(([k, v]) => score(k, v))].sort((a, b) => b.skill - a.skill);
}
