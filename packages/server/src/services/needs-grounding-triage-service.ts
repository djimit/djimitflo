import type { Database } from 'better-sqlite3';

/**
 * Way out of `needs_grounding` (plan E2/E9c). Every Commons learning with a proposed_improvement becomes a `reflection`
 * proposal; most name no path, so the grounding gate parks them in needs_grounding, a status nothing consumed (prod
 * 2026-09-23: 118 + ~26 per night). Acts on the latest `reflection_triage` judgment per proposal:
 *   djimitflo_change (conf >= 0.6)          -> needs_more_evidence, where refinement asks for target + acceptance test (#293)
 *   other_system / aspiration (conf >= 0.8)  -> archived
 * Uses a shadow judgment to act, so it is behind NEEDS_GROUNDING_TRIAGE_ENABLED (default off; operator decision, ADR 0002).
 */
export const needsGroundingTriageEnabled = (): boolean => process.env.NEEDS_GROUNDING_TRIAGE_ENABLED === 'true';
const MAX_PER_RUN = 10;

export interface TriageResult { toRefinement: number; archived: number; skipped: number }

export class NeedsGroundingTriageService {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly db: Database) {}

  start(intervalMs = 6 * 3600_000): void {
    if (this.timer || !needsGroundingTriageEnabled()) return;
    const run = () => { try { const r = this.run(); if (r.toRefinement || r.archived) console.log(`🧭 needs_grounding triage: refine=${r.toRefinement} archived=${r.archived}`); } catch (err) { console.warn('needs_grounding triage failed:', err instanceof Error ? err.message : String(err)); } };
    this.timer = setInterval(run, intervalMs); this.timer.unref?.();
    setTimeout(run, 150_000).unref?.();
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  run(): TriageResult {
    const rows = this.db.prepare(`
      SELECT s.id, j.reason FROM self_improvements s
      JOIN judgments j ON j.subject_id = s.id AND j.judgment = 'reflection_triage'
        AND j.created_at = (SELECT MAX(created_at) FROM judgments WHERE subject_id = s.id AND judgment = 'reflection_triage')
      WHERE s.status = 'needs_grounding' ORDER BY s.created_at ASC LIMIT ?`).all(MAX_PER_RUN) as Array<{ id: string; reason: string | null }>;
    const result: TriageResult = { toRefinement: 0, archived: 0, skipped: 0 };
    const now = new Date().toISOString();
    const move = this.db.prepare("UPDATE self_improvements SET status = ?, updated_at = ? WHERE id = ? AND status = 'needs_grounding'");
    for (const row of rows) {
      const kind = /jev=([a-z_]+)/.exec(row.reason || '')?.[1];
      const conf = Number(/conf=([0-9.]+)/.exec(row.reason || '')?.[1] ?? 0);
      if (kind === 'djimitflo_change' && conf >= 0.6) { result.toRefinement += move.run('needs_more_evidence', now, row.id).changes; continue; }
      if ((kind === 'other_system' || kind === 'aspiration') && conf >= 0.8) { result.archived += move.run('archived', now, row.id).changes; continue; }
      result.skipped += 1;
    }
    return result;
  }
}
