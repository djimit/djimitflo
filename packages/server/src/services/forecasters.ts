import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { forecastOf } from './forecast-scoring';

/**
 * Plan AR2 step 1: the first forecaster population for "this proposal ends verified", scored by forecast-scoring (AR1).
 * Two code forecasters, no model calls, recorded once per proposal before any gate decides:
 *  - base_rate: the verified rate of the proposal's source (Laplace-smoothed) — the bar every other forecaster must beat;
 *  - jev_calibrated: jev's prescreen answers recalibrated on resolved history (System One guide, principle 6: use the
 *    probabilities as features). Backfill 2026-10-02: raw prescreen product Brier 0.41 vs base rate 0.11 — badly calibrated.
 * ponytail: histogram calibration (source × prescreen bucket), not logistic regression; replace when n per bucket > 200.
 */
const RESOLVED = "('verified','applied','regressed','no_change','infra_failed','needs_more_evidence','archived')";
const PRIOR = 2; // Laplace weight toward the source rate

const bucket = (p: number) => (p >= 0.5 ? 'high' : p >= 0.15 ? 'mid' : 'low');

export function sourceRate(db: Database, source: string): number {
  const r = db.prepare(`SELECT SUM(status IN ('verified','applied')) AS k, COUNT(*) AS n FROM self_improvements WHERE source = ? AND status IN ${RESOLVED}`).get(source) as { k: number | null; n: number };
  return ((r.k ?? 0) + 1) / (r.n + 2);
}

/** Calibrated P(verified) for a prescreen forecast p: the empirical rate among resolved proposals of the same source and bucket. */
export function calibrated(db: Database, source: string, p: number): number {
  const rows = db.prepare(`SELECT s.status, j.answers_json FROM self_improvements s JOIN judgments j ON j.subject_id = s.id AND j.judgment = 'proposal_prescreen'
    WHERE s.source = ? AND s.status IN ${RESOLVED} AND j.decision <> 'error' GROUP BY s.id`).all(source) as Array<{ status: string; answers_json: string | null }>;
  let k = 0; let n = 0;
  for (const r of rows) {
    let a = {}; try { a = JSON.parse(r.answers_json || '{}'); } catch { continue; }
    const q = forecastOf('proposal_prescreen', a as never);
    if (q === null || bucket(q) !== bucket(p)) continue;
    n += 1; if (r.status === 'verified' || r.status === 'applied') k += 1;
  }
  const base = sourceRate(db, source);
  return (k + PRIOR * base) / (n + PRIOR);
}

function record(db: Database, forecaster: string, subjectId: string, p: number, reason: string): void {
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, latency_ms, model, created_at)
    VALUES (?, ?, 'self_improvement', ?, '', 'shadow', ?, ?, ?, 0, 'code', ?)`)
    .run(randomUUID(), `forecast:${forecaster}`, subjectId, p >= 0.5 ? 'yes' : 'no', reason, JSON.stringify({ p }), new Date().toISOString());
}

/** Records each code forecaster once per proposal; prescreenAnswers is the jev prescreen of this tick (null when off/failed). */
export function recordForecasts(db: Database, proposal: { id: string; source: string }, prescreenAnswers: Record<string, unknown> | null): void {
  try {
    const has = (f: string) => db.prepare('SELECT 1 FROM judgments WHERE judgment = ? AND subject_id = ? LIMIT 1').get(`forecast:${f}`, proposal.id);
    if (!has('base_rate')) { const p = sourceRate(db, proposal.source); record(db, 'base_rate', proposal.id, p, `source=${proposal.source}`); }
    const raw = prescreenAnswers ? forecastOf('proposal_prescreen', prescreenAnswers as never) : null;
    if (raw !== null && !has('jev_calibrated')) record(db, 'jev_calibrated', proposal.id, calibrated(db, proposal.source, raw), `raw=${raw.toFixed(3)} bucket=${bucket(raw)}`);
  } catch { /* forecasting must never break the review tick */ }
}
