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
    let answers: { as_of?: unknown } = {}; try { answers = JSON.parse(r.answers_json || '{}'); } catch { /* unparsable: skip */ }
    // AR-W: an async forecast counts from the moment its input was frozen (as_of, before the goal), not when it was written
    const madeAt = typeof answers.as_of === 'string' ? answers.as_of : r.created_at;
    if (prop.goal_at && madeAt >= prop.goal_at) continue; // after the gate decided: leakage
    const key = `${r.judgment}|${r.subject_id}`; if (seen.has(key)) continue; seen.add(key); // first forecast per subject only
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

/**
 * RX-7 (Phase F, shadow): forecast scoring V2. V1 above stays byte-identical (arenaGate, fleetSourceGate and committee
 * evolution read it). V1's baseline is an in-sample, hindsight rate (it includes the scored proposal and later outcomes), so a
 * forecaster with no positives gets a strongly negative skill and gates can fire on noise. V2:
 *  - baseline = trailing out-of-sample source rate: proposals of the same source resolved strictly before the forecast was
 *    made (resolution time = self_improvements.updated_at), shrunk as (k + 0.5) / (n + 1) so an empty history is not 0;
 *  - skill, AUC and the paired Brier gain (baseline − forecaster, same rows) each with a seeded cluster bootstrap CI
 *    (cluster = proposal, B = 2000);
 *  - decision_grade only with ≥ 10 positives, n ≥ 100 and a skill CI that excludes 0 — otherwise 'insufficient';
 *  - rows of proposals that never got a goal (no leakage filter possible) are scored but counted apart (null_goal_n).
 * Read-only; nothing acts on V2.
 */
export interface ForecasterScoreV2 {
  forecaster: string; n: number; positives: number; null_goal_n: number; brier: number; baselineBrier: number;
  skill: number; skill_ci: [number, number]; auc: number | null; auc_ci: [number, number] | null; brier_gain: number; brier_gain_ci: [number, number];
  state: 'decision_grade' | 'insufficient';
}
export interface StopComparison { forecaster: string; v1_n: number; v1_skill: number; v1_stop: boolean; v2_state: ForecasterScoreV2['state'] | 'unscored'; v2_skill_ci: [number, number] | null; v2_stop: boolean }

/** mulberry32, the same PRNG as the gym's mutants (kept local so scoring does not import the gym). */
const seeded = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
};
const pct = (xs: number[], q: number): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))]; };

export function forecastScoresV2(db: Database, opts: { sinceDays?: number; seed?: number; boot?: number } = {}): { forecasters: ForecasterScoreV2[]; would_have_stopped: StopComparison[] } {
  const since = new Date(Date.now() - (opts.sinceDays ?? 60) * 86_400_000).toISOString();
  const B = opts.boot ?? 2000;
  // fail-soft: a schema without proposals/judgments yields an empty result, never a 500
  let resolved: Array<{ id: string; source: string; status: string; resolved_at: string; created_at: string; goal_at: string | null }> = [];
  try { resolved = db.prepare(`SELECT s.id, s.source, s.status, s.updated_at AS resolved_at, s.created_at, (SELECT MIN(g.created_at) FROM goals g WHERE g.improvement_id = s.id) AS goal_at
    FROM self_improvements s WHERE s.status IN (${RESOLVED.map(() => '?').join(',')})`).all(...RESOLVED) as typeof resolved; } catch { return { forecasters: [], would_have_stopped: [] }; }
  const outcome = (s: string) => (VERIFIED.has(s) ? 1 : 0);
  const bySource = new Map<string, Array<{ at: string; o: number }>>();
  for (const p of resolved) { const l = bySource.get(p.source) ?? []; l.push({ at: p.resolved_at, o: outcome(p.status) }); bySource.set(p.source, l); }
  for (const l of bySource.values()) l.sort((a, b) => (a.at < b.at ? -1 : 1));
  const trailingRate = (source: string, at: string): number => {
    let k = 0; let n = 0; for (const r of bySource.get(source) ?? []) { if (r.at >= at) break; n++; k += r.o; }
    return (k + 0.5) / (n + 1);
  };
  const byId = new Map(resolved.filter((p) => p.created_at >= since).map((p) => [p.id, p]));
  let rows: Array<{ judgment: string; subject_id: string; answers_json: string | null; created_at: string }> = [];
  try {
    rows = db.prepare(`SELECT judgment, subject_id, answers_json, created_at FROM judgments
      WHERE subject_type = 'self_improvement' AND decision <> 'error' AND (judgment = 'proposal_prescreen' OR judgment LIKE 'forecast:%') AND created_at >= ?
      ORDER BY created_at, id`).all(since) as typeof rows;
  } catch { return { forecasters: [], would_have_stopped: [] }; }
  type Row = { p: number; o: number; base: number; subject: string; nullGoal: boolean };
  const pairs = new Map<string, Row[]>(); const seen = new Set<string>();
  for (const r of rows) {
    const prop = byId.get(r.subject_id); if (!prop) continue;
    let answers: { as_of?: unknown } = {}; try { answers = JSON.parse(r.answers_json || '{}'); } catch { /* unparsable: skip */ }
    const madeAt = typeof answers.as_of === 'string' ? answers.as_of : r.created_at;
    if (prop.goal_at && madeAt >= prop.goal_at) continue;
    const key = `${r.judgment}|${r.subject_id}`; if (seen.has(key)) continue; seen.add(key);
    const p = forecastOf(r.judgment, answers as never); if (p === null) continue;
    const list = pairs.get(r.judgment) ?? [];
    list.push({ p, o: outcome(prop.status), base: trailingRate(prop.source, madeAt), subject: r.subject_id, nullGoal: !prop.goal_at });
    pairs.set(r.judgment, list);
  }
  const stats = (list: Row[]) => {
    const b = brier(list.map((r) => [r.p, r.o])); const base = brier(list.map((r) => [r.base, r.o]));
    return { b, base, skill: base > 0 ? 1 - b / base : 0, auc: auc(list.map((r) => [r.p, r.o])) };
  };
  const forecasters: ForecasterScoreV2[] = [...pairs.entries()].map(([name, list]): ForecasterScoreV2 => {
    const s = stats(list);
    // cluster = proposal; one forecast per (forecaster, proposal) after the dedupe, so resampling clusters = resampling rows
    const clusters = [...new Set(list.map((r) => r.subject))].map((id) => list.filter((r) => r.subject === id));
    const random = seeded((opts.seed ?? 20261005) + name.length);
    const skills: number[] = []; const gains: number[] = []; const aucs: number[] = [];
    for (let i = 0; i < B; i++) {
      const sample: Row[] = [];
      for (let j = 0; j < clusters.length; j++) sample.push(...clusters[Math.floor(random() * clusters.length)]);
      const t = stats(sample); skills.push(t.skill); gains.push(t.base - t.b); if (t.auc !== null) aucs.push(t.auc);
    }
    const skill_ci: [number, number] = [pct(skills, 0.025), pct(skills, 0.975)];
    const positives = list.filter((r) => r.o).length;
    const grade = positives >= 10 && list.length >= 100 && (skill_ci[0] > 0 || skill_ci[1] < 0);
    return {
      forecaster: name, n: list.length, positives, null_goal_n: list.filter((r) => r.nullGoal).length, brier: s.b, baselineBrier: s.base,
      skill: s.skill, skill_ci, auc: s.auc, auc_ci: aucs.length ? [pct(aucs, 0.025), pct(aucs, 0.975)] : null,
      brier_gain: s.base - s.b, brier_gain_ci: [pct(gains, 0.025), pct(gains, 0.975)], state: grade ? 'decision_grade' : 'insufficient',
    };
  }).sort((a, b) => b.skill - a.skill);
  // what each rule would do to residents and committee members (V1 = arenaGate / extinction: n ≥ 30 and skill < 0)
  const v1 = new Map((() => { try { return forecastScores(db, opts.sinceDays ?? 60); } catch { return []; } })().map((s) => [s.forecaster, s]));
  const names = new Set([...v1.keys(), ...pairs.keys()].filter((k) => k.startsWith('forecast:resident:') || k.startsWith('forecast:committee:')));
  const would_have_stopped: StopComparison[] = [...names].sort().map((name) => {
    const a = v1.get(name); const b = forecasters.find((f) => f.forecaster === name);
    return {
      forecaster: name, v1_n: a?.n ?? 0, v1_skill: a?.skill ?? 0, v1_stop: !!a && a.n >= 30 && a.skill < 0,
      v2_state: b?.state ?? 'unscored', v2_skill_ci: b?.skill_ci ?? null, v2_stop: !!b && b.state === 'decision_grade' && b.skill_ci[1] < 0,
    };
  });
  return { forecasters, would_have_stopped };
}
