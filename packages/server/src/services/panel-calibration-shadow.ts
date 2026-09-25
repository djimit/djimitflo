import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

/**
 * C3 (plan WS-N): panel votes weighted by each juror's track record, in shadow only. Prod 2026-09-24: 1 600 votes,
 * 71 % right at 0.95 stated confidence — every juror counts the same whatever its record. When a panel reaches consensus
 * two judgments are recorded: `panel_unweighted` (what the panel actually decided) and `panel_weighted` (what a vote
 * weighted by Laplace-smoothed accuracy would have decided), both yes = authorise a goal. The funnel scores both against
 * the proposal's outcome, so the comparison is apples to apples. Nothing here changes a decision.
 * PANEL_WEIGHTED_SHADOW_ENABLED=true (default off).
 */
export const panelWeightedShadowEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.PANEL_WEIGHTED_SHADOW_ENABLED === 'true';

/** Laplace-smoothed accuracy per specialist over panels whose proposal has an outcome (verified / regressed). */
export function specialistAccuracy(db: Database): Map<string, number> {
  const rows = db.prepare(`SELECT r.specialist_id AS s,
      SUM(p.status IN ('verified', 'regressed')) AS n,
      SUM((r.stance = 'support' AND p.status = 'verified') OR (r.stance = 'oppose' AND p.status = 'regressed')
        OR (r.stance IN ('needs_evidence', 'oppose') AND p.status = 'regressed')) AS right
    FROM specialist_reviews r JOIN self_improvements p ON p.panel_id = r.panel_id WHERE r.status = 'submitted' GROUP BY r.specialist_id`).all() as Array<{ s: string; n: number | null; right: number | null }>;
  return new Map(rows.map((r) => [r.s, ((r.right ?? 0) + 1) / ((r.n ?? 0) + 2)]));
}

/** Weighted support in [-1, 1]: support +1, oppose -1, needs_evidence/uncertain 0, each vote scaled by its accuracy. */
export function weightedDecision(reviews: Array<{ specialist_id: string; stance: string }>, accuracy: Map<string, number>): { yes: boolean; score: number } {
  let sum = 0; let weights = 0;
  for (const r of reviews) {
    const w = accuracy.get(r.specialist_id) ?? 0.5;
    weights += w;
    sum += w * (r.stance === 'support' ? 1 : r.stance === 'oppose' ? -1 : 0);
  }
  const score = weights ? sum / weights : 0;
  return { yes: score >= 0.6, score: Math.round(score * 100) / 100 };
}

export function recordPanelShadow(db: Database, panelId: string, reviews: Array<{ specialist_id: string; stance: string }>, actualDecision: string): void {
  if (!panelWeightedShadowEnabled()) return;
  try {
    if (db.prepare("SELECT 1 FROM judgments WHERE judgment = 'panel_weighted' AND subject_id = ?").get(panelId)) return;
    const accuracy = specialistAccuracy(db);
    const weighted = weightedDecision(reviews, accuracy);
    const weights = reviews.map((r) => `${r.specialist_id}=${(accuracy.get(r.specialist_id) ?? 0.5).toFixed(2)}:${r.stance}`).join(' ');
    const insert = db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, latency_ms, model, created_at)
      VALUES (?, ?, 'specialist_panel', ?, '', 'shadow', ?, ?, '{}', 0, 'calibration-v1', ?)`);
    const now = new Date().toISOString();
    insert.run(randomUUID(), 'panel_weighted', panelId, weighted.yes ? 'yes' : 'no', `score=${weighted.score} actual=${actualDecision} ${weights}`, now);
    insert.run(randomUUID(), 'panel_unweighted', panelId, actualDecision === 'goal' ? 'yes' : 'no', `actual=${actualDecision}`, now);
  } catch { /* shadow bookkeeping never affects the panel */ }
}
