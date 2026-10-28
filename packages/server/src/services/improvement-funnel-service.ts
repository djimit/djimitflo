import type { Database } from 'better-sqlite3';
import { DreamStateService } from './dream-state-service';
import { supersededMergeOutcomeSql } from './merge-superseded';

/** Read-only SQL aggregation of the whole improvement chain, so "where does it leak" is one call. */

export interface ImprovementFunnel {
  generatedAt: string;
  proposals: { total: number; byStatus: Record<string, number> };
  bySource: Array<{ source: string; total: number; parked: number; archived: number; needsGrounding: number; reachedGoal: number; verified: number; failed: number }>;
  /**
   * decisions: every panel's consensus. goalRate (DF-02): goal decisions over the decided panels a proposal points at
   * (self_improvements.panel_id, each panel once) — linkedDecided is its denominator, linkedDecisions its breakdown.
   */
  panel: { decisions: Record<string, number>; goalRate: number | null; linkedPanels: number; linkedDecided: number; linkedDecisions: Record<string, number> };
  /**
   * childOutcomes: the children's own status, which stays archived/no_change when a goal ran (DF-01). childGoals: children with a
   * goal (goals.improvement_id) and how those goals ended — the conversion a refinement actually made.
   */
  refinement: { originals: number | null; children: number | null; childOutcomes: Record<string, number>; childGoals: { reachedGoal: number; completed: number; failed: number; other: number } | null };
  goals: { fromSelfImprovement: Record<string, number> };
  learning: { cognitiveEpisodes: number | null; cognitivePatterns: number | null; cognitiveStrategies: number | null; learningClosures: number | null; memoryCandidates: Record<string, number> };
  kpi: {
    /** verified/regressed: proposals whose CURRENT status is positive/regressed and whose updated_at falls in the window — not first verifications. */
    windowDays: number; verified: number | null; regressed: number | null; regressionRate: number | null;
    /** panels24h/7d count panels created; reviews24h/7d count submitted specialist reviews (DF-03) */
    panels24h: number | null; panels7d: number | null; reviews24h: number | null; reviews7d: number | null;
    /**
     * UX-003: median of created_at → current updated_at over proposals currently verified/evaluating/applied and updated within
     * medianHoursWindowDays (n = medianHoursN). No first-verification timestamp is stored, so this is NOT first-verification latency.
     */
    panelsPerVerified: number | null; medianHoursToVerified: number | null; medianHoursWindowDays: number; medianHoursN: number | null; approvalsPerRun: number | null;
    /** J6: what a verified change costs — maker tokens and runs over the window (skill_outcomes, one row per run). */
    runs: number; runSuccessRate: number | null; tokensPerVerified: number | null;
  };
  /** UX-004: null = the read failed or its table is absent (reason in `unavailable`), never a healthy 0. */
  hygiene: { zombieGoals: number | null; staleRuns: number | null; blockedBoardItems: number | null };
  /**
   * UX-002: openWorkItems is COUNT(*) over every open row; workItemsByLoop is only the largest workItemsByLoopLimit
   * (loop, status) groups of workItemGroups.
   */
  queues: { openWorkItems: number | null; workItemGroups: number | null; workItemsByLoopLimit: number; workItemsByLoop: Array<{ loop: string; status: string; n: number }>; commonsReviews: Record<string, number> };
  /** UX-004: metric → why it could not be read (`missing_schema: …` for an absent table/column, `query_failed: …` otherwise). */
  unavailable: Record<string, string>;
  /** TypeSafe judgments (ADR 0002): volume, latency and agreement with the final outcome where one exists (plan E7/E10). */
  judgments: Array<{ judgment: string; total: number; byDecision: Record<string, number>; medianLatencyMs: number | null; withOutcome: number; agreement: number | null }>;
  /**
   * E11 step 5: calibration per panel specialist against what the proposal became. A vote is right when `support` met a
   * verified outcome or `oppose` met a regressed one; mean confidence next to accuracy shows over-confidence.
   */
  panelCalibration: Array<{ specialist: string; votes: number; withOutcome: number; accuracy: number | null; meanConfidence: number | null }>;
  /** Last dream passes, one verdict each (G13a). */
  dreamLedger: ReturnType<DreamStateService['ledger']>;
}

/** How a judgment's subject resolves to a final outcome: true = positive, false = negative, null = still open / no outcome. */
export const OUTCOME_SQL: Record<string, string> = {
  proposal_prescreen: `SELECT CASE WHEN status IN ('verified','evaluating','applied') THEN 1 WHEN status IN ('archived','regressed','rejected','no_change') THEN 0 END AS o FROM self_improvements WHERE id = ?`,
  reflection_triage: `SELECT CASE WHEN status IN ('verified','evaluating','applied') THEN 1 WHEN status IN ('archived','regressed','rejected','no_change') THEN 0 END AS o FROM self_improvements WHERE id = ?`,
  checker_second_opinion: `SELECT CASE WHEN r.status = 'completed' THEN 1 WHEN r.status IN ('blocked','failed','cancelled') THEN 0 END AS o FROM worker_leases l JOIN loop_runs r ON r.id = l.loop_run_id WHERE l.id = ?`,
  // plan E3: agreement of the shadow auto-approve rule with the operator's real decision
  auto_approve_shadow: `SELECT CASE WHEN status = 'approved' THEN 1 WHEN status IN ('denied','rejected','expired') THEN 0 END AS o FROM approvals WHERE id = ?`,
  // C3: the weighted-vote shadow and the actual panel decision, scored on the same outcome (yes = a goal should follow)
  panel_weighted: `SELECT CASE WHEN status IN ('verified','evaluating','applied') THEN 1 WHEN status IN ('regressed','rejected') THEN 0 END AS o FROM self_improvements WHERE panel_id = ? LIMIT 1`,
  panel_unweighted: `SELECT CASE WHEN status IN ('verified','evaluating','applied') THEN 1 WHEN status IN ('regressed','rejected') THEN 0 END AS o FROM self_improvements WHERE panel_id = ? LIMIT 1`,
};
/** Before #334 the checker opinion saw an empty diff for new files; those rows say nothing about the model (ADR 0002). */
const EXCLUDE_BEFORE: Record<string, string> = { checker_second_opinion: '2026-09-23T18:30:00Z' };

const REACHED_GOAL = ['scheduled', 'executing', 'verified', 'evaluating', 'applied', 'no_change', 'regressed', 'infra_failed'];
const OPEN_WORK = "status IN ('candidate','triaged','planned','leased','blocked')";
const WORK_GROUP_LIMIT = 12;
const MEDIAN_WINDOW_DAYS = 30;

const median = (sorted: number[]) => {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export class ImprovementFunnelService {
  private unavailable: Record<string, string> = {};

  constructor(private readonly db: Database) {}

  private rows<T>(sql: string, ...params: unknown[]): T[] {
    try { return this.db.prepare(sql).all(...params) as T[]; } catch { return []; } // optional tables may not exist on older instances
  }

  /** UX-004: a read that records why it failed instead of turning into [] → 0. */
  private tryRows<T>(metric: string, sql: string): T[] | null {
    try { return this.db.prepare(sql).all() as T[]; } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.unavailable[metric] = `${/no such (table|column)/i.test(message) ? 'missing_schema' : 'query_failed'}: ${message}`;
      return null;
    }
  }

  private one(metric: string, sql: string): number | null {
    const rows = this.tryRows<{ n: number }>(metric, sql);
    return rows === null ? null : rows[0]?.n ?? 0;
  }

  private counts(sql: string, metric?: string): Record<string, number> {
    const rows = metric ? this.tryRows<{ k: string | null; n: number }>(metric, sql) ?? [] : this.rows<{ k: string | null; n: number }>(sql);
    return Object.fromEntries(rows.map((r) => [r.k ?? 'unknown', r.n]));
  }

  private runCost(since: string, verified: number): { runs: number; runSuccessRate: number | null; tokensPerVerified: number | null } {
    try {
      const r = this.db.prepare(`SELECT COUNT(*) AS runs, SUM(success) AS ok, SUM(tokens_used) AS tokens FROM skill_outcomes WHERE skill_id LIKE ? AND created_at >= ? AND NOT ${supersededMergeOutcomeSql('skill_outcomes')}`)
        .get('loop-maker:%', since) as { runs: number; ok: number | null; tokens: number | null };
      return { runs: r.runs, runSuccessRate: r.runs ? (r.ok ?? 0) / r.runs : null, tokensPerVerified: verified && r.tokens ? Math.round(r.tokens / verified) : null };
    } catch { return { runs: 0, runSuccessRate: null, tokensPerVerified: null }; } // skill_outcomes is created lazily
  }

  panelCalibration(): ImprovementFunnel['panelCalibration'] {
    try {
      const rows = this.db.prepare(`
        SELECT r.specialist_id AS specialist, COUNT(*) AS votes,
          SUM(s.status IN ('verified', 'regressed')) AS withOutcome,
          SUM((r.stance = 'support' AND s.status = 'verified') OR (r.stance = 'oppose' AND s.status = 'regressed')) AS right,
          AVG(CASE WHEN s.status IN ('verified', 'regressed') THEN r.confidence END) AS meanConfidence
        FROM specialist_reviews r JOIN self_improvements s ON s.panel_id = r.panel_id
        WHERE r.status = 'submitted'
        GROUP BY r.specialist_id ORDER BY votes DESC`).all() as Array<{ specialist: string; votes: number; withOutcome: number | null; right: number | null; meanConfidence: number | null }>;
      return rows.map((r) => ({ specialist: r.specialist, votes: r.votes, withOutcome: r.withOutcome ?? 0,
        accuracy: r.withOutcome ? (r.right ?? 0) / r.withOutcome : null,
        meanConfidence: r.meanConfidence === null ? null : Math.round(r.meanConfidence * 100) / 100 }));
    } catch { return []; }
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

  /** DF-01: refined children that got a goal (goals.improvement_id is unique), by how the goal ended. */
  private childGoals(): ImprovementFunnel['refinement']['childGoals'] {
    const rows = this.tryRows<{ k: string | null; n: number }>('refinementChildGoals', 'SELECT g.status AS k, COUNT(*) AS n FROM goals g JOIN self_improvements s ON s.id = g.improvement_id WHERE s.refined_from_id IS NOT NULL GROUP BY g.status');
    if (rows === null) return null; // UX-004: unknown, never "0 reached goal"
    const by: Record<string, number> = Object.fromEntries(rows.map((r) => [r.k ?? 'unknown', r.n]));
    const reachedGoal = Object.values(by).reduce((a, b) => a + b, 0);
    const completed = by.completed ?? 0; const failed = by.failed ?? 0;
    return { reachedGoal, completed, failed, other: reachedGoal - completed - failed };
  }

  compute(): ImprovementFunnel {
    this.unavailable = {};
    const byStatus = this.counts('SELECT status AS k, COUNT(*) AS n FROM self_improvements GROUP BY status', 'proposals');
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
    const linkedPanelSql = 'SELECT DISTINCT panel_id FROM self_improvements WHERE panel_id IS NOT NULL';
    const linkedDecisions = this.counts(`SELECT json_extract(consensus_json, '$.decision') AS k, COUNT(*) AS n FROM specialist_panels WHERE consensus_json IS NOT NULL AND id IN (${linkedPanelSql}) GROUP BY k`);
    const linkedDecided = Object.values(linkedDecisions).reduce((a, b) => a + b, 0);
    const one = (metric: string, sql: string) => this.one(metric, sql);
    const workItemsByLoop = this.tryRows<{ loop: string; status: string; n: number }>('workItemsByLoop',
      `SELECT COALESCE(recommended_loop, 'none') AS loop, status, COUNT(*) AS n FROM work_items WHERE ${OPEN_WORK} GROUP BY 1, 2 ORDER BY n DESC LIMIT ${WORK_GROUP_LIMIT}`) ?? [];
    const openWorkItems = one('openWorkItems', `SELECT COUNT(*) AS n FROM work_items WHERE ${OPEN_WORK}`);
    const workItemGroups = one('workItemGroups', `SELECT COUNT(*) AS n FROM (SELECT 1 FROM work_items WHERE ${OPEN_WORK} GROUP BY COALESCE(recommended_loop, 'none'), status)`);
    const now = Date.now();
    const iso = (ms: number) => new Date(now - ms).toISOString();
    const DAY = 86_400_000;
    const verified7 = one('verified', `SELECT COUNT(*) AS n FROM self_improvements WHERE status IN ('verified', 'evaluating', 'applied') AND updated_at >= '${iso(7 * DAY)}'`);
    const regressed7 = one('regressed', `SELECT COUNT(*) AS n FROM self_improvements WHERE status = 'regressed' AND updated_at >= '${iso(7 * DAY)}'`);
    const reviews = (metric: string, ms: number) => one(metric, `SELECT COUNT(*) AS n FROM specialist_reviews WHERE status = 'submitted' AND julianday(created_at) >= julianday('${iso(ms)}')`);
    const panels7 = one('panels7d', `SELECT COUNT(*) AS n FROM specialist_panels WHERE created_at >= '${iso(7 * DAY)}'`);
    const hours = this.tryRows<{ h: number }>('medianHoursToVerified', `SELECT (julianday(updated_at) - julianday(created_at)) * 24 AS h FROM self_improvements WHERE status IN ('verified', 'evaluating', 'applied') AND updated_at >= '${iso(MEDIAN_WINDOW_DAYS * DAY)}' AND updated_at > created_at ORDER BY h`)?.map((r) => r.h) ?? null;
    const medianHours = hours === null ? null : median(hours);
    const approvals = this.rows<{ approvals: number; runs: number }>(`
      SELECT COUNT(*) AS approvals, COUNT(DISTINCT json_extract(t.metadata, '$.loop_run_id')) AS runs FROM approvals a JOIN tasks t ON t.id = a.task_id
      WHERE a.status = 'approved' AND a.created_at >= '${iso(7 * DAY)}' AND json_valid(COALESCE(t.metadata, '{}')) = 1 AND json_extract(t.metadata, '$.loop_run_id') IS NOT NULL`)[0];
    const kpi: ImprovementFunnel['kpi'] = {
      windowDays: 7, verified: verified7, regressed: regressed7,
      regressionRate: verified7 !== null && regressed7 !== null && verified7 + regressed7 ? regressed7 / (verified7 + regressed7) : null,
      panels24h: one('panels24h', `SELECT COUNT(*) AS n FROM specialist_panels WHERE created_at >= '${iso(DAY)}'`), panels7d: panels7,
      reviews24h: reviews('reviews24h', DAY), reviews7d: reviews('reviews7d', 7 * DAY),
      panelsPerVerified: verified7 && panels7 !== null ? Math.round(panels7 / verified7) : null,
      medianHoursToVerified: medianHours === null ? null : Math.round(medianHours * 10) / 10,
      medianHoursWindowDays: MEDIAN_WINDOW_DAYS, medianHoursN: hours === null ? null : hours.length,
      approvalsPerRun: approvals?.runs ? Math.round((approvals.approvals / approvals.runs) * 10) / 10 : null,
      ...this.runCost(iso(7 * DAY), verified7 ?? 0),
    };
    const hygiene: ImprovementFunnel['hygiene'] = {
      zombieGoals: one('zombieGoals', `SELECT COUNT(*) AS n FROM goals WHERE (status = 'running' AND updated_at < '${iso(DAY)}' AND NOT EXISTS (SELECT 1 FROM loop_runs r WHERE r.goal_id = goals.id AND r.status IN ('running', 'planning', 'verifying') AND r.updated_at >= '${iso(DAY)}'))
        OR (status = 'blocked' AND updated_at < '${iso(7 * DAY)}' AND json_extract(COALESCE(NULLIF(metadata, ''), '{}'), '$.awaiting_approval') IS NULL)`),
      staleRuns: one('staleRuns', `SELECT COUNT(*) AS n FROM loop_runs WHERE (status = 'interrupted' AND updated_at < '${iso(2 * DAY)}') OR (status = 'planning' AND updated_at < '${iso(DAY)}')`),
      blockedBoardItems: one('blockedBoardItems', "SELECT COUNT(*) AS n FROM work_items WHERE source = 'agent_board' AND status = 'blocked'"),
    };
    return {
      judgments: this.judgmentAgreement(),
      dreamLedger: new DreamStateService(this.db).ledger(),
      panelCalibration: this.panelCalibration(),
      generatedAt: new Date().toISOString(),
      proposals: { total, byStatus },
      bySource: [...perSource.values()].sort((a, b) => b.total - a.total),
      panel: { decisions, goalRate: linkedDecided ? (linkedDecisions.goal ?? 0) / linkedDecided : null, linkedPanels: one('linkedPanels', `SELECT COUNT(*) AS n FROM (${linkedPanelSql})`) ?? 0, linkedDecided, linkedDecisions },
      refinement: {
        originals: one('refinementOriginals', 'SELECT COUNT(*) AS n FROM self_improvements WHERE refined_at IS NOT NULL'),
        children: one('refinementChildren', 'SELECT COUNT(*) AS n FROM self_improvements WHERE refined_from_id IS NOT NULL'),
        childOutcomes: this.counts('SELECT status AS k, COUNT(*) AS n FROM self_improvements WHERE refined_from_id IS NOT NULL GROUP BY status'),
        childGoals: this.childGoals(),
      },
      goals: { fromSelfImprovement: this.counts("SELECT status AS k, COUNT(*) AS n FROM goals WHERE improvement_id IS NOT NULL GROUP BY status") },
      learning: {
        cognitiveEpisodes: one('cognitiveEpisodes', 'SELECT COUNT(*) AS n FROM cognitive_episodes'),
        cognitivePatterns: one('cognitivePatterns', 'SELECT COUNT(*) AS n FROM cognitive_patterns'),
        cognitiveStrategies: one('cognitiveStrategies', 'SELECT COUNT(*) AS n FROM cognitive_strategies'),
        learningClosures: one('learningClosures', 'SELECT COUNT(*) AS n FROM loop_learning_closures'),
        memoryCandidates: this.counts('SELECT status AS k, COUNT(*) AS n FROM memory_candidates GROUP BY status'),
      },
      kpi, hygiene,
      queues: {
        openWorkItems, workItemGroups, workItemsByLoopLimit: WORK_GROUP_LIMIT, workItemsByLoop,
        commonsReviews: this.counts('SELECT status AS k, COUNT(*) AS n FROM commons_proposal_reviews GROUP BY status', 'commonsReviews'),
      },
      unavailable: { ...this.unavailable },
    };
  }
}
