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
  kpi: {
    windowDays: number; verified: number; regressed: number; regressionRate: number | null; panels24h: number; panels7d: number;
    panelsPerVerified: number | null; medianHoursToVerified: number | null; approvalsPerRun: number | null;
    /** J6: what a verified change costs — maker tokens and runs over the window (skill_outcomes, one row per run). */
    runs: number; runSuccessRate: number | null; tokensPerVerified: number | null;
  };
  hygiene: { zombieGoals: number; staleRuns: number; blockedBoardItems: number };
  queues: { openWorkItems: number; workItemsByLoop: Array<{ loop: string; status: string; n: number }>; commonsReviews: Record<string, number> };
  /** TypeSafe judgments (ADR 0002): volume, latency and agreement with the final outcome where one exists (plan E7/E10). */
  judgments: Array<{ judgment: string; total: number; byDecision: Record<string, number>; medianLatencyMs: number | null; withOutcome: number; agreement: number | null }>;
}

/** How a judgment's subject resolves to a final outcome: true = positive, false = negative, null = still open / no outcome. */
const OUTCOME_SQL: Record<string, string> = {
  proposal_prescreen: `SELECT CASE WHEN status IN ('verified','evaluating','applied') THEN 1 WHEN status IN ('archived','regressed','rejected','no_change') THEN 0 END AS o FROM self_improvements WHERE id = ?`,
  reflection_triage: `SELECT CASE WHEN status IN ('verified','evaluating','applied') THEN 1 WHEN status IN ('archived','regressed','rejected','no_change') THEN 0 END AS o FROM self_improvements WHERE id = ?`,
  checker_second_opinion: `SELECT CASE WHEN r.status = 'completed' THEN 1 WHEN r.status IN ('blocked','failed','cancelled') THEN 0 END AS o FROM worker_leases l JOIN loop_runs r ON r.id = l.loop_run_id WHERE l.id = ?`,
  // plan E3: agreement of the shadow auto-approve rule with the operator's real decision
  auto_approve_shadow: `SELECT CASE WHEN status = 'approved' THEN 1 WHEN status IN ('denied','rejected','expired') THEN 0 END AS o FROM approvals WHERE id = ?`,
};
/** Before #334 the checker opinion saw an empty diff for new files; those rows say nothing about the model (ADR 0002). */
const EXCLUDE_BEFORE: Record<string, string> = { checker_second_opinion: '2026-09-23T18:30:00Z' };

const REACHED_GOAL = ['scheduled', 'executing', 'verified', 'evaluating', 'applied', 'no_change', 'regressed'];

export class ImprovementFunnelService {
  constructor(private readonly db: Database) {}

  private rows<T>(sql: string, ...params: unknown[]): T[] {
    try { return this.db.prepare(sql).all(...params) as T[]; } catch { return []; } // optional tables may not exist on older instances
  }

  private counts(sql: string): Record<string, number> {
    return Object.fromEntries(this.rows<{ k: string | null; n: number }>(sql).map((r) => [r.k ?? 'unknown', r.n]));
  }

  private runCost(since: string, verified: number): { runs: number; runSuccessRate: number | null; tokensPerVerified: number | null } {
    try {
      const r = this.db.prepare('SELECT COUNT(*) AS runs, SUM(success) AS ok, SUM(tokens_used) AS tokens FROM skill_outcomes WHERE skill_id LIKE ? AND created_at >= ?')
        .get('loop-maker:%', since) as { runs: number; ok: number | null; tokens: number | null };
      return { runs: r.runs, runSuccessRate: r.runs ? (r.ok ?? 0) / r.runs : null, tokensPerVerified: verified && r.tokens ? Math.round(r.tokens / verified) : null };
    } catch { return { runs: 0, runSuccessRate: null, tokensPerVerified: null }; } // skill_outcomes is created lazily
  }

  judgmentAgreement(): ImprovementFunnel['judgments'] {
    const rows = this.rows<{ judgment: string; subject_id: string; decision: string; latency_ms: number | null; created_at: string }>(
      'SELECT judgment, subject_id, decision, latency_ms, created_at FROM judgments ORDER BY judgment');
    const byJudgment = new Map<string, typeof rows>();
    for (const r of rows) byJudgment.set(r.judgment, [...(byJudgment.get(r.judgment) ?? []), r]);
    return [...byJudgment.entries()].map(([judgment, list]) => {
      const byDecision: Record<string, number> = {};
      for (const r of list) byDecision[r.decision] = (byDecision[r.decision] ?? 0) + 1;
      const lat = list.map((r) => r.latency_ms).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
      let withOutcome = 0; let agree = 0;
      const sql = OUTCOME_SQL[judgment];
      if (sql) for (const r of list) {
        if (r.decision !== 'yes' && r.decision !== 'no') continue;
        if (EXCLUDE_BEFORE[judgment] && r.created_at < EXCLUDE_BEFORE[judgment]) continue;
        const o = this.rows<{ o: number | null }>(sql, r.subject_id)[0]?.o;
        if (o === null || o === undefined) continue;
        withOutcome += 1; if ((r.decision === 'yes') === (o === 1)) agree += 1;
      }
      return { judgment, total: list.length, byDecision, medianLatencyMs: lat.length ? lat[Math.floor(lat.length / 2)] : null, withOutcome, agreement: withOutcome ? agree / withOutcome : null };
    });
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
    const now = Date.now();
    const iso = (ms: number) => new Date(now - ms).toISOString();
    const DAY = 86_400_000;
    const verified7 = one(`SELECT COUNT(*) AS n FROM self_improvements WHERE status IN ('verified', 'evaluating', 'applied') AND updated_at >= '${iso(7 * DAY)}'`);
    const regressed7 = one(`SELECT COUNT(*) AS n FROM self_improvements WHERE status = 'regressed' AND updated_at >= '${iso(7 * DAY)}'`);
    const panels7 = one(`SELECT COUNT(*) AS n FROM specialist_panels WHERE created_at >= '${iso(7 * DAY)}'`);
    const hours = this.rows<{ h: number }>(`SELECT (julianday(updated_at) - julianday(created_at)) * 24 AS h FROM self_improvements WHERE status IN ('verified', 'evaluating', 'applied') AND updated_at >= '${iso(30 * DAY)}' AND updated_at > created_at ORDER BY h`).map((r) => r.h);
    const approvals = this.rows<{ approvals: number; runs: number }>(`
      SELECT COUNT(*) AS approvals, COUNT(DISTINCT json_extract(t.metadata, '$.loop_run_id')) AS runs FROM approvals a JOIN tasks t ON t.id = a.task_id
      WHERE a.status = 'approved' AND a.created_at >= '${iso(7 * DAY)}' AND json_valid(COALESCE(t.metadata, '{}')) = 1 AND json_extract(t.metadata, '$.loop_run_id') IS NOT NULL`)[0];
    const kpi: ImprovementFunnel['kpi'] = {
      windowDays: 7, verified: verified7, regressed: regressed7,
      regressionRate: verified7 + regressed7 ? regressed7 / (verified7 + regressed7) : null,
      panels24h: one(`SELECT COUNT(*) AS n FROM specialist_panels WHERE created_at >= '${iso(DAY)}'`), panels7d: panels7,
      panelsPerVerified: verified7 ? Math.round(panels7 / verified7) : null,
      medianHoursToVerified: hours.length ? Math.round(hours[Math.floor(hours.length / 2)] * 10) / 10 : null,
      approvalsPerRun: approvals?.runs ? Math.round((approvals.approvals / approvals.runs) * 10) / 10 : null,
      ...this.runCost(iso(7 * DAY), verified7),
    };
    const hygiene: ImprovementFunnel['hygiene'] = {
      zombieGoals: one(`SELECT COUNT(*) AS n FROM goals WHERE (status = 'running' AND updated_at < '${iso(DAY)}' AND NOT EXISTS (SELECT 1 FROM loop_runs r WHERE r.goal_id = goals.id AND r.status IN ('running', 'planning', 'verifying') AND r.updated_at >= '${iso(DAY)}'))
        OR (status = 'blocked' AND updated_at < '${iso(7 * DAY)}' AND json_extract(COALESCE(NULLIF(metadata, ''), '{}'), '$.awaiting_approval') IS NULL)`),
      staleRuns: one(`SELECT COUNT(*) AS n FROM loop_runs WHERE (status = 'interrupted' AND updated_at < '${iso(2 * DAY)}') OR (status = 'planning' AND updated_at < '${iso(DAY)}')`),
      blockedBoardItems: one("SELECT COUNT(*) AS n FROM work_items WHERE source = 'agent_board' AND status = 'blocked'"),
    };
    return {
      judgments: this.judgmentAgreement(),
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
      kpi, hygiene,
      queues: {
        openWorkItems: workItemsByLoop.reduce((a, r) => a + r.n, 0),
        workItemsByLoop,
        commonsReviews: this.counts('SELECT status AS k, COUNT(*) AS n FROM commons_proposal_reviews GROUP BY status'),
      },
    };
  }
}
