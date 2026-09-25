import type { Database } from 'better-sqlite3';

/**
 * Calibration of specialist stances against what their proposals later achieved.
 *
 * Each submitted support/oppose review is a probability claim that the proposal will succeed
 * (support -> confidence, oppose -> 1 - confidence). Success = the proposal reached
 * verified/evaluating/applied; failure = regressed/rejected. Parked/in-flight proposals
 * have no outcome yet and are excluded. Brier = mean squared error (0 perfect, 0.25 = coin flip).
 * Only proposals that reached a goal have outcomes, so n is small by construction: report it.
 */

export interface SpecialistCalibration {
  specialistId: string;
  n: number;
  brier: number | null;
  meanPredicted: number | null;
  observedSuccessRate: number | null;
  bins: Array<{ from: number; to: number; n: number; observed: number }>;
}

const SUCCESS = ['verified', 'evaluating', 'applied'];
// no_change is deliberately unlabeled: 13 production proposals ended there only because the old doc-drift
// dispatch never looked at their objective, which says nothing about the specialists' judgement.
const FAILURE = ['regressed', 'rejected'];

export class PanelCalibrationService {
  constructor(private readonly db: Database) {}

  compute(): SpecialistCalibration[] {
    const rows = this.db.prepare(`
      SELECT r.specialist_id, r.stance, r.confidence, s.status
      FROM specialist_reviews r
      JOIN self_improvements s ON s.panel_id = r.panel_id
      WHERE r.status = 'submitted' AND r.stance IN ('support', 'oppose')
        AND s.status IN (${[...SUCCESS, ...FAILURE].map(() => '?').join(',')})
    `).all(...SUCCESS, ...FAILURE) as Array<{ specialist_id: string; stance: string; confidence: number; status: string }>;

    const bySpecialist = new Map<string, Array<{ p: number; y: number }>>();
    for (const row of rows) {
      const p = row.stance === 'support' ? row.confidence : 1 - row.confidence;
      const list = bySpecialist.get(row.specialist_id) ?? [];
      list.push({ p, y: SUCCESS.includes(row.status) ? 1 : 0 });
      bySpecialist.set(row.specialist_id, list);
    }
    return [...bySpecialist.entries()].map(([specialistId, obs]) => {
      const n = obs.length;
      const mean = (f: (o: { p: number; y: number }) => number) => obs.reduce((sum, o) => sum + f(o), 0) / n;
      const bins = [0, 0.2, 0.4, 0.6, 0.8].map((from) => {
        const inBin = obs.filter((o) => o.p >= from && (from === 0.8 ? o.p <= 1 : o.p < from + 0.2));
        return { from, to: Math.round((from + 0.2) * 10) / 10, n: inBin.length, observed: inBin.length ? inBin.reduce((s, o) => s + o.y, 0) / inBin.length : 0 };
      });
      return { specialistId, n, brier: mean((o) => (o.p - o.y) ** 2), meanPredicted: mean((o) => o.p), observedSuccessRate: mean((o) => o.y), bins };
    }).sort((a, b) => a.specialistId.localeCompare(b.specialistId));
  }
}
