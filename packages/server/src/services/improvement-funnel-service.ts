import type { Database } from 'better-sqlite3';

/** Read-only SQL aggregation of the whole improvement chain, so "where does it leak" is one call. */

export interface ImprovementFunnel {
  generatedAt: string;
  proposals: { total: number; byStatus: Record<string, number> };
  bySource: Array<{ source: string; total: number; parked: number; archived: number; needsGrounding: number; reachedGoal: number; verified: number; failed: number }>;
  panel: { decisions: Record<string, number>; goalRate: number | null };
  refinement: { originals: number; children: number; childOutcomes: Record<string, number> };
  goals: { fromSelfImprovement: Record<string, number> };
  learning: { cognitiveEpisodes: number; cognitivePatterns: number; cognitiveStrategies: number; learningClosures: number; memoryCandidates: Record<string, number> };
  queues: { openWorkItems: number; workItemsByLoop: Array<{ loop: string; status: string; n: number }>; commonsReviews: Record<string, number> };
}

const REACHED_GOAL = ['scheduled', 'executing', 'verified', 'evaluating', 'applied', 'no_change', 'regressed'];

export class ImprovementFunnelService {
  constructor(private readonly db: Database) {}

  private rows<T>(sql: string, ...params: unknown[]): T[] {
    try { return this.db.prepare(sql).all(...params) as T[]; } catch { return []; } // optional tables may not exist on older instances
  }

  private counts(sql: string): Record<string, number> {
    return Object.fromEntries(this.rows<{ k: string | null; n: number }>(sql).map((r) => [r.k ?? 'unknown', r.n]));
  }

  compute(): ImprovementFunnel {
    const byStatus = this.counts('SELECT status AS k, COUNT(*) AS n FROM self_improvements GROUP BY status');
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const bySource = this.rows<{ source: string; status: string; n: number }>('SELECT source, status, COUNT(*) AS n FROM self_improvements GROUP BY source, status');
    const perSource = new Map<string, ImprovementFunnel['bySource'][number]>();
    for (const r of bySource) {
      const s = perSource.get(r.source) ?? { source: r.source, total: 0, parked: 0, archived: 0, needsGrounding: 0, reachedGoal: 0, verified: 0, failed: 0 };
      s.total += r.n;
      if (r.status === 'needs_more_evidence') s.parked += r.n;
      if (r.status === 'archived') s.archived += r.n;
      if (r.status === 'needs_grounding') s.needsGrounding += r.n;
      if (REACHED_GOAL.includes(r.status)) s.reachedGoal += r.n;
      if (['verified', 'evaluating', 'applied'].includes(r.status)) s.verified += r.n;
      if (['no_change', 'regressed', 'rejected'].includes(r.status)) s.failed += r.n;
      perSource.set(r.source, s);
    }
    const decisions = this.counts("SELECT json_extract(consensus_json, '$.decision') AS k, COUNT(*) AS n FROM specialist_panels WHERE consensus_json IS NOT NULL GROUP BY k");
    const decided = Object.values(decisions).reduce((a, b) => a + b, 0);
    const one = (sql: string) => this.rows<{ n: number }>(sql)[0]?.n ?? 0;
    const workItemsByLoop = this.rows<{ loop: string; status: string; n: number }>(
      "SELECT COALESCE(recommended_loop, 'none') AS loop, status, COUNT(*) AS n FROM work_items WHERE status IN ('candidate','triaged','planned','leased','blocked') GROUP BY 1, 2 ORDER BY n DESC LIMIT 12");
    return {
      generatedAt: new Date().toISOString(),
      proposals: { total, byStatus },
      bySource: [...perSource.values()].sort((a, b) => b.total - a.total),
      panel: { decisions, goalRate: decided ? (decisions.goal ?? 0) / decided : null },
      refinement: {
        originals: one('SELECT COUNT(*) AS n FROM self_improvements WHERE refined_at IS NOT NULL'),
        children: one('SELECT COUNT(*) AS n FROM self_improvements WHERE refined_from_id IS NOT NULL'),
        childOutcomes: this.counts('SELECT status AS k, COUNT(*) AS n FROM self_improvements WHERE refined_from_id IS NOT NULL GROUP BY status'),
      },
      goals: { fromSelfImprovement: this.counts("SELECT status AS k, COUNT(*) AS n FROM goals WHERE improvement_id IS NOT NULL GROUP BY status") },
      learning: {
        cognitiveEpisodes: one('SELECT COUNT(*) AS n FROM cognitive_episodes'),
        cognitivePatterns: one('SELECT COUNT(*) AS n FROM cognitive_patterns'),
        cognitiveStrategies: one('SELECT COUNT(*) AS n FROM cognitive_strategies'),
        learningClosures: one('SELECT COUNT(*) AS n FROM loop_learning_closures'),
        memoryCandidates: this.counts('SELECT status AS k, COUNT(*) AS n FROM memory_candidates GROUP BY status'),
      },
      queues: {
        openWorkItems: workItemsByLoop.reduce((a, r) => a + r.n, 0),
        workItemsByLoop,
        commonsReviews: this.counts('SELECT status AS k, COUNT(*) AS n FROM commons_proposal_reviews GROUP BY status'),
      },
    };
  }
}
