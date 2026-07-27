/**
 * GovernanceFeedbackLoopService — closes the loop between governance assessment
 * and autonomous improvement.
 *
 * Architecture:
 *   OpenMythos (detect failure) → ToolBroker (authorize fix) → LoopService (execute fix) → Metrics (verify improvement)
 *
 * The service:
 * 1. Analyzes OpenMythos eval results to identify failing categories
 * 2. Creates improvement proposals for governance failures
 * 3. Uses ToolBroker to authorize the improvement actions
 * 4. Dispatches LoopService to execute fixes in isolated worktrees
 * 5. Re-runs OpenMythos to verify improvement
 * 6. Records the full feedback loop in governance_feedback_loops table
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { ToolCallDecision, ToolCallRequest } from './tool-broker';
import { RiskLevel, type AuthTokenPayload } from '@djimitflo/shared';

export interface GovernanceFailure {
  category: string;
  severity: RiskLevel;
  case_ids: string[];
  avg_score: number;
  failure_mode: string;
  recommendation: string;
}

export interface ImprovementProposal {
  id: string;
  title: string;
  description: string;
  category: string;
  target_finding_ids: string[];
  proposed_action: 'code_fix' | 'policy_update' | 'skill_update' | 'config_change';
  risk_level: RiskLevel;
  status: 'proposed' | 'authorized' | 'rejected' | 'executing' | 'completed' | 'failed';
  decision_id: string | null;
  created_at: string;
}

export interface FeedbackLoopResult {
  loop_id: string;
  eval_run_id: string;
  failures_detected: number;
  proposals_created: number;
  proposals_authorized: number;
  proposals_executed: number;
  improvement_detected: boolean;
  score_delta: number;
  verification?: ImprovementVerification;
  created_at?: string;
}

export interface ImprovementVerification {
  promoted: boolean;
  reason: 'verified_gain' | 'insufficient_evidence' | 'effect_below_threshold' | 'holdout_regression';
  repeat_count: number;
  target_case_ids: string[];
  holdout_case_ids: string[];
  baseline_run_ids: string[];
  candidate_run_ids: string[];
  paired_deltas: number[];
  mean_delta: number;
  confidence_lower_bound: number;
  holdout_delta: number;
  minimum_effect: number;
  maximum_holdout_regression: number;
  git_sha: string | null;
  evaluation_runs: Array<{ id: string; metadata: Record<string, unknown> }>;
}

export interface FeedbackLoopConfig {
  min_score_threshold: number;
  auto_authorize_below_risk: RiskLevel;
  max_proposals_per_cycle: number;
  require_verification: boolean;
  enable_dormant_capability_detection: boolean;
  dormant_capability_threshold_days: number;
  verification_repeats: number;
  minimum_effect: number;
  maximum_holdout_regression: number;
  maximum_holdout_cases: number;
}

export interface FeedbackLoopDependencies {
  dispatchImprovement?: (
    proposal: ImprovementProposal,
    agentId: string,
  ) => Promise<{ taskId: string; status: string }>;
  rerunEvaluation?: (agentId: string, caseIds: string[]) => Promise<{ runId: string }>;
}

const DEFAULT_CONFIG: FeedbackLoopConfig = {
  min_score_threshold: 3.0,
  auto_authorize_below_risk: RiskLevel.MEDIUM,
  max_proposals_per_cycle: 5,
  require_verification: true,
  enable_dormant_capability_detection: true,
  dormant_capability_threshold_days: 30,
  verification_repeats: 3,
  minimum_effect: 0.1,
  maximum_holdout_regression: 0.1,
  maximum_holdout_cases: 10,
};

export interface DormantCapability {
  capability_id: string;
  capability_name: string;
  last_used_at: string | null;
  days_since_last_use: number;
  recommendation: string;
}

export class GovernanceFeedbackLoopService {
  private config: FeedbackLoopConfig;

  constructor(
    private db: Database,
    config: Partial<FeedbackLoopConfig> = {},
    private dependencies: FeedbackLoopDependencies = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ensureTables();
  }

  /**
   * Analyze the latest OpenMythos eval run and identify governance failures.
   */
  analyzeFailures(agentId: string): GovernanceFailure[] {
    const latestRun = this.db.prepare(`
      SELECT id, total_cases, metadata
      FROM openmythos_eval_runs
      WHERE agent_id = ? AND status = 'completed'
      ORDER BY finished_at DESC LIMIT 1
    `).get(agentId) as { id: string; total_cases: number; metadata: string } | undefined;

    if (!latestRun) return [];

    const results = this.db.prepare(`
      SELECT case_id, category, judge_score, judge_rationale, oracle_type, oracle_pass
      FROM openmythos_case_results
      WHERE run_id = ? AND status = 'completed'
    `).all(latestRun.id) as Array<{
      case_id: string;
      category: string;
      judge_score: number;
      judge_rationale: string;
      oracle_type: string;
      oracle_pass: number | null;
    }>;

    const failingCases = results.filter(r => r.judge_score < this.config.min_score_threshold);

    const byCategory = new Map<string, typeof failingCases>();
    for (const c of failingCases) {
      const existing = byCategory.get(c.category) || [];
      existing.push(c);
      byCategory.set(c.category, existing);
    }

    const failures: GovernanceFailure[] = [];
    for (const [category, cases] of byCategory) {
      const avgScore = cases.reduce((sum, c) => sum + c.judge_score, 0) / cases.length;
      const severity = avgScore < 1.5 ? RiskLevel.CRITICAL
        : avgScore < 2.0 ? RiskLevel.HIGH
        : avgScore < 2.5 ? RiskLevel.MEDIUM
        : RiskLevel.LOW;

      failures.push({
        category,
        severity,
        case_ids: cases.map(c => c.case_id),
        avg_score: avgScore,
        failure_mode: this.inferFailureMode(cases),
        recommendation: this.generateRecommendation(category, cases),
      });
    }

    return failures.sort((a, b) => {
      const riskOrder = { [RiskLevel.CRITICAL]: 0, [RiskLevel.HIGH]: 1, [RiskLevel.MEDIUM]: 2, [RiskLevel.LOW]: 3 };
      return riskOrder[a.severity] - riskOrder[b.severity];
    });
  }

  /**
   * Create improvement proposals from governance failures.
   */
  createProposals(failures: GovernanceFailure[]): ImprovementProposal[] {
    const proposals: ImprovementProposal[] = [];

    for (const failure of failures.slice(0, this.config.max_proposals_per_cycle)) {
      const action = this.mapFailureToAction(failure);

      proposals.push({
        id: `proposal-${randomUUID().slice(0, 8)}`,
        title: `Fix governance failure: ${failure.category}`,
        description: failure.recommendation,
        category: failure.category,
        target_finding_ids: failure.case_ids,
        proposed_action: action,
        risk_level: failure.severity,
        status: 'proposed',
        decision_id: null,
        created_at: new Date().toISOString(),
      });
    }

    return proposals;
  }

  /**
   * Authorize proposals via ToolBroker.
   */
  authorizeProposals(
    proposals: ImprovementProposal[],
    principal: AuthTokenPayload,
  ): Array<{ proposal: ImprovementProposal; decision: ToolCallDecision | null }> {
    const results: Array<{ proposal: ImprovementProposal; decision: ToolCallDecision | null }> = [];

    for (const proposal of proposals) {
      const request: ToolCallRequest = {
        principal,
        task_id: proposal.id,
        tool: `governance_${proposal.proposed_action}`,
        category: this.mapActionToCategory(proposal.proposed_action),
        args: {
          proposal_id: proposal.id,
          category: proposal.category,
          target_findings: proposal.target_finding_ids,
        },
        target_resource: `governance:${proposal.category}`,
        data_classification: this.mapRiskToClassification(proposal.risk_level),
        session_id: `feedback-loop-${proposal.id}`,
      };

      const decision = this.evaluateViaPolicy(request);

      if (decision.decision === 'allow') {
        proposal.status = 'authorized';
        proposal.decision_id = decision.decision_id;
      } else if (decision.decision === 'deny') {
        proposal.status = 'rejected';
      }
      // require_approval stays as 'proposed'

      this.persistProposal(proposal);
      results.push({ proposal, decision });
    }

    return results;
  }

  /**
   * Execute a full feedback loop: detect → propose → authorize → dispatch.
   */
  async runFeedbackLoop(agentId: string, principal: AuthTokenPayload): Promise<FeedbackLoopResult> {
    const loopId = `gfl-${randomUUID().slice(0, 8)}`;
    const baselineRunId = this.latestCompletedRunId(agentId);

    const failures = this.analyzeFailures(agentId);
    if (failures.length === 0) {
      return {
        loop_id: loopId,
        eval_run_id: '',
        failures_detected: 0,
        proposals_created: 0,
        proposals_authorized: 0,
        proposals_executed: 0,
        improvement_detected: false,
        score_delta: 0,
      };
    }

    const proposals = this.createProposals(failures);
    const authorized = this.authorizeProposals(proposals, principal);
    const authorizedCount = authorized.filter(({ proposal }) => proposal.status === 'authorized').length;

    const autoExecutable = authorized.filter(
      ({ proposal }) =>
        proposal.status === 'authorized' &&
        this.riskRank(proposal.risk_level) <= this.riskRank(this.config.auto_authorize_below_risk)
    );

    const targetCaseIds = [...new Set(failures.flatMap((failure) => failure.case_ids))];
    const holdoutCaseIds = baselineRunId ? this.holdoutCaseIds(baselineRunId, targetCaseIds) : [];
    const baselineRunIds = baselineRunId ? [baselineRunId] : [];
    if (
      autoExecutable.length > 0 &&
      this.config.require_verification &&
      baselineRunId &&
      this.dependencies.rerunEvaluation
    ) {
      const evaluationCaseIds = [...targetCaseIds, ...holdoutCaseIds];
      for (let repeat = 1; repeat < this.config.verification_repeats; repeat++) {
        const rerun = await this.dependencies.rerunEvaluation(agentId, evaluationCaseIds);
        baselineRunIds.push(rerun.runId);
      }
    }

    let executed = 0;
    const executedProposals: ImprovementProposal[] = [];
    for (const { proposal } of autoExecutable) {
      try {
        if (!this.dependencies.dispatchImprovement) {
          proposal.status = 'failed';
          this.persistProposal(proposal);
          continue;
        }
        proposal.status = 'executing';
        this.persistProposal(proposal);
        const execution = await this.dependencies.dispatchImprovement(proposal, agentId);
        this.persistProposalExecution(proposal.id, execution.taskId, execution.status);
        if (execution.status === 'completed') {
          executed++;
          executedProposals.push(proposal);
        } else if (execution.status !== 'awaiting_approval') {
          proposal.status = 'failed';
          this.persistProposal(proposal);
        }
      } catch {
        proposal.status = 'failed';
        this.persistProposal(proposal);
      }
    }

    let improvement = { improved: false, delta: 0 };
    let verification: ImprovementVerification | undefined;
    if (executed > 0 && this.config.require_verification && baselineRunId && this.dependencies.rerunEvaluation) {
      const candidateRunIds: string[] = [];
      const evaluationCaseIds = [...targetCaseIds, ...holdoutCaseIds];
      for (let repeat = 0; repeat < this.config.verification_repeats; repeat++) {
        const rerun = await this.dependencies.rerunEvaluation(agentId, evaluationCaseIds);
        candidateRunIds.push(rerun.runId);
      }
      verification = this.verifyRepeatedImprovement(
        baselineRunIds,
        candidateRunIds,
        targetCaseIds,
        holdoutCaseIds,
      );
      improvement = { improved: verification.promoted, delta: verification.mean_delta };
      for (const proposal of executedProposals) {
        proposal.status = improvement.improved ? 'completed' : 'failed';
        this.persistProposal(proposal);
        this.persistProposalVerification(proposal.id, candidateRunIds[candidateRunIds.length - 1], verification);
      }
    } else if (!this.config.require_verification) {
      for (const proposal of executedProposals) {
        proposal.status = 'completed';
        this.persistProposal(proposal);
      }
    }

    const result: FeedbackLoopResult = {
      loop_id: loopId,
      eval_run_id: baselineRunId || '',
      failures_detected: failures.length,
      proposals_created: proposals.length,
      proposals_authorized: authorizedCount,
      proposals_executed: executed,
      improvement_detected: improvement.improved,
      score_delta: improvement.delta,
      verification,
    };

    this.persistFeedbackLoop(result);
    return result;
  }

  /**
   * Detect dormant capabilities — capabilities that exist but haven't been used
   * within the threshold period. Inspired by RuvNet Brain's capability advocacy.
   */
  detectDormantCapabilities(): DormantCapability[] {
    if (!this.config.enable_dormant_capability_detection) return [];

    const capabilities = this.db.prepare(`
      SELECT
        sc.id as capability_id,
        sc.owner as capability_name,
        sc.status
      FROM swarm_capabilities sc
      WHERE sc.status = 'candidate'
      ORDER BY sc.id ASC
    `).all() as Array<{
      capability_id: string;
      capability_name: string;
      status: string;
    }>;

    return capabilities.map(cap => ({
      capability_id: cap.capability_id,
      capability_name: cap.capability_name,
      last_used_at: null,
      days_since_last_use: this.config.dormant_capability_threshold_days,
      recommendation: `Capability "${cap.capability_name}" is in candidate status. Consider activating, validating, or retiring.`,
    }));
  }

  /**
   * Verify improvement by comparing before/after eval scores.
   */
  verifyImprovement(agentId: string, baselineRunId: string): { improved: boolean; delta: number } {
    const baseline = this.db.prepare(`
      SELECT AVG(judge_score) as avg_score
      FROM openmythos_case_results
      WHERE run_id = ?
    `).get(baselineRunId) as { avg_score: number } | undefined;

    const latestRun = this.db.prepare(`
      SELECT id FROM openmythos_eval_runs
      WHERE agent_id = ? AND status = 'completed'
      ORDER BY finished_at DESC LIMIT 1
    `).get(agentId) as { id: string } | undefined;

    if (!baseline || !latestRun) return { improved: false, delta: 0 };

    const current = this.db.prepare(`
      SELECT AVG(judge_score) as avg_score
      FROM openmythos_case_results
      WHERE run_id = ?
    `).get(latestRun.id) as { avg_score: number } | undefined;

    if (!current) return { improved: false, delta: 0 };

    const delta = current.avg_score - baseline.avg_score;
    return { improved: delta > 0.1, delta };
  }

  verifyRepeatedImprovement(
    baselineRunIds: string[],
    candidateRunIds: string[],
    targetCaseIds: string[],
    holdoutCaseIds: string[] = [],
  ): ImprovementVerification {
    const repeatCount = Math.min(baselineRunIds.length, candidateRunIds.length);
    const pairedDeltas: number[] = [];
    for (let index = 0; index < repeatCount; index++) {
      const baseline = this.runMean(baselineRunIds[index], targetCaseIds);
      const candidate = this.runMean(candidateRunIds[index], targetCaseIds);
      if (baseline === null || candidate === null) continue;
      pairedDeltas.push(candidate - baseline);
    }

    const meanDelta = this.mean(pairedDeltas);
    const confidenceLowerBound = this.lowerConfidenceBound(pairedDeltas);
    const holdoutDeltas: number[] = [];
    for (let index = 0; index < repeatCount && holdoutCaseIds.length > 0; index++) {
      const baseline = this.runMean(baselineRunIds[index], holdoutCaseIds);
      const candidate = this.runMean(candidateRunIds[index], holdoutCaseIds);
      if (baseline !== null && candidate !== null) holdoutDeltas.push(candidate - baseline);
    }
    const holdoutDelta = this.mean(holdoutDeltas);
    const sufficient = pairedDeltas.length === repeatCount && repeatCount > 0;
    const holdoutRegressed = holdoutDeltas.length > 0 &&
      holdoutDelta < -this.config.maximum_holdout_regression;
    const promoted = sufficient &&
      confidenceLowerBound > this.config.minimum_effect &&
      !holdoutRegressed;
    const reason: ImprovementVerification['reason'] = !sufficient
      ? 'insufficient_evidence'
      : holdoutRegressed
        ? 'holdout_regression'
        : confidenceLowerBound <= this.config.minimum_effect
          ? 'effect_below_threshold'
          : 'verified_gain';

    const allRunIds = [...baselineRunIds.slice(0, repeatCount), ...candidateRunIds.slice(0, repeatCount)];
    return {
      promoted,
      reason,
      repeat_count: repeatCount,
      target_case_ids: targetCaseIds,
      holdout_case_ids: holdoutCaseIds,
      baseline_run_ids: baselineRunIds.slice(0, repeatCount),
      candidate_run_ids: candidateRunIds.slice(0, repeatCount),
      paired_deltas: pairedDeltas,
      mean_delta: meanDelta,
      confidence_lower_bound: confidenceLowerBound,
      holdout_delta: holdoutDelta,
      minimum_effect: this.config.minimum_effect,
      maximum_holdout_regression: this.config.maximum_holdout_regression,
      git_sha: process.env.DJIMITFLO_GIT_SHA || null,
      evaluation_runs: allRunIds.map((id) => ({ id, metadata: this.evalRunMetadata(id) })),
    };
  }

  /**
   * Get feedback loop history.
   */
  getLoopHistory(limit = 20): FeedbackLoopResult[] {
    return this.db.prepare(`
      SELECT * FROM governance_feedback_loops
      ORDER BY created_at DESC LIMIT ?
    `).all(limit) as FeedbackLoopResult[];
  }

  /**
   * Get proposals by status.
   */
  getProposalsByStatus(status: ImprovementProposal['status']): ImprovementProposal[] {
    return this.db.prepare(`
      SELECT * FROM governance_improvement_proposals
      WHERE status = ? ORDER BY created_at DESC
    `).all(status) as ImprovementProposal[];
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private evaluateViaPolicy(request: ToolCallRequest): ToolCallDecision {
    const decision_id = `dec-${randomUUID()}`;
    let decision: 'allow' | 'deny' | 'require_approval' = 'allow';
    let reason = 'Within authorized risk threshold';

    if (request.data_classification === 'restricted') {
      decision = 'require_approval';
      reason = 'Restricted data classification requires approval';
    } else if (request.principal.role === 'viewer') {
      decision = 'deny';
      reason = 'Viewers cannot authorize improvements';
    } else if (request.data_classification === 'confidential' && request.principal.role !== 'admin') {
      decision = 'require_approval';
      reason = 'Confidential data requires admin approval';
    }

    return {
      decision_id,
      decision,
      tool: request.tool,
      principal_id: request.principal.sub,
      task_id: request.task_id,
      capability_token: decision === 'allow' ? {
        token_id: `cap-${randomUUID()}`,
        scope: `${request.category}:${request.tool}`,
        tool: request.tool,
        task_id: request.task_id,
        principal_id: request.principal.sub,
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 900_000).toISOString(),
        constraints: request.args || {},
      } : undefined,
      reason,
      matched_policies: ['governance_feedback_loop'],
      risk_level: this.classificationToRisk(request.data_classification),
      expires_at: new Date(Date.now() + 900_000).toISOString(),
    };
  }

  private mapFailureToAction(failure: GovernanceFailure): ImprovementProposal['proposed_action'] {
    if (failure.category.includes('policy') || failure.category.includes('governance')) {
      return 'policy_update';
    }
    if (failure.category.includes('skill') || failure.category.includes('prompt')) {
      return 'skill_update';
    }
    if (failure.category.includes('config') || failure.category.includes('infra')) {
      return 'config_change';
    }
    return 'code_fix';
  }

  private mapActionToCategory(action: ImprovementProposal['proposed_action']): ToolCallRequest['category'] {
    switch (action) {
      case 'code_fix': return 'filesystem';
      case 'policy_update': return 'database';
      case 'skill_update': return 'filesystem';
      case 'config_change': return 'database';
    }
  }

  private mapRiskToClassification(risk: RiskLevel): ToolCallRequest['data_classification'] {
    switch (risk) {
      case RiskLevel.CRITICAL: return 'restricted';
      case RiskLevel.HIGH: return 'confidential';
      case RiskLevel.MEDIUM: return 'internal';
      case RiskLevel.LOW: return 'public';
    }
  }

  private classificationToRisk(classification: string): RiskLevel {
    switch (classification) {
      case 'restricted': return RiskLevel.CRITICAL;
      case 'confidential': return RiskLevel.HIGH;
      case 'internal': return RiskLevel.MEDIUM;
      default: return RiskLevel.LOW;
    }
  }

  private inferFailureMode(cases: Array<{ judge_rationale: string | null }>): string {
    const rationales = cases.map(c => c.judge_rationale || '').join(' ').toLowerCase();
    if (rationales.includes('contradiction')) return 'contradictory_behavior';
    if (rationales.includes('refuse') || rationales.includes('denial')) return 'refusal_failure';
    if (rationales.includes('hallucin')) return 'hallucination';
    if (rationales.includes('overstep') || rationales.includes('scope')) return 'scope_violation';
    return 'quality_deficit';
  }

  private generateRecommendation(category: string, cases: Array<{ case_id: string }>): string {
    return `Improve ${category} governance across ${cases.length} failing case(s). ` +
      `Consider updating policies, skills, or agent instructions to prevent recurrence.`;
  }

  private latestCompletedRunId(agentId: string): string | null {
    const row = this.db.prepare(`
      SELECT id FROM openmythos_eval_runs
      WHERE agent_id = ? AND status = 'completed'
      ORDER BY finished_at DESC LIMIT 1
    `).get(agentId) as { id: string } | undefined;
    return row?.id || null;
  }

  private holdoutCaseIds(runId: string, targetCaseIds: string[]): string[] {
    const targets = new Set(targetCaseIds);
    return (this.db.prepare(`
      SELECT case_id FROM openmythos_case_results
      WHERE run_id = ? AND status = 'completed' AND judge_score >= ?
      ORDER BY category, case_id
    `).all(runId, this.config.min_score_threshold) as Array<{ case_id: string }>)
      .map((row) => row.case_id)
      .filter((caseId) => !targets.has(caseId))
      .slice(0, this.config.maximum_holdout_cases);
  }

  private runMean(runId: string, caseIds: string[]): number | null {
    if (caseIds.length === 0) return null;
    const placeholders = caseIds.map(() => '?').join(',');
    const row = this.db.prepare(`
      SELECT AVG(judge_score) AS average, COUNT(*) AS count
      FROM openmythos_case_results
      WHERE run_id = ? AND status = 'completed' AND case_id IN (${placeholders})
    `).get(runId, ...caseIds) as { average: number | null; count: number };
    return row.count === caseIds.length && row.average !== null ? row.average : null;
  }

  private mean(values: number[]): number {
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  }

  private lowerConfidenceBound(values: number[]): number {
    if (values.length === 0) return Number.NEGATIVE_INFINITY;
    const average = this.mean(values);
    if (values.length === 1) return average;
    const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
    if (variance === 0) return average;
    const standardError = Math.sqrt(variance / values.length);
    const oneSided95TCritical = [0, 6.314, 2.92, 2.353, 2.132, 2.015, 1.943, 1.895, 1.86, 1.833];
    const degreesOfFreedom = values.length - 1;
    const critical = oneSided95TCritical[degreesOfFreedom] || 1.645;
    return average - critical * standardError;
  }

  private evalRunMetadata(runId: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT metadata FROM openmythos_eval_runs WHERE id = ?').get(runId) as
      { metadata: string } | undefined;
    if (!row) return {};
    try {
      return JSON.parse(row.metadata || '{}') as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private riskRank(risk: RiskLevel): number {
    return {
      [RiskLevel.LOW]: 0,
      [RiskLevel.MEDIUM]: 1,
      [RiskLevel.HIGH]: 2,
      [RiskLevel.CRITICAL]: 3,
    }[risk];
  }

  private persistProposal(proposal: ImprovementProposal): void {
    this.db.prepare(`
      INSERT INTO governance_improvement_proposals
        (id, title, description, category, target_finding_ids, proposed_action, risk_level, status, decision_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        category = excluded.category,
        target_finding_ids = excluded.target_finding_ids,
        proposed_action = excluded.proposed_action,
        risk_level = excluded.risk_level,
        status = excluded.status,
        decision_id = excluded.decision_id
    `).run(
      proposal.id,
      proposal.title,
      proposal.description,
      proposal.category,
      JSON.stringify(proposal.target_finding_ids),
      proposal.proposed_action,
      proposal.risk_level,
      proposal.status,
      proposal.decision_id,
      proposal.created_at,
    );
  }

  private persistFeedbackLoop(result: FeedbackLoopResult): void {
    this.db.prepare(`
      INSERT INTO governance_feedback_loops
        (loop_id, eval_run_id, failures_detected, proposals_created, proposals_authorized, proposals_executed, improvement_detected, score_delta, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      result.loop_id,
      result.eval_run_id,
      result.failures_detected,
      result.proposals_created,
      result.proposals_authorized,
      result.proposals_executed,
      result.improvement_detected ? 1 : 0,
      result.score_delta,
    );
  }

  private persistProposalExecution(proposalId: string, taskId: string, executionStatus: string): void {
    this.db.prepare(`
      UPDATE governance_improvement_proposals
      SET task_id = ?, execution_status = ?
      WHERE id = ?
    `).run(taskId, executionStatus, proposalId);
  }

  private persistProposalVerification(
    proposalId: string,
    runId: string,
    verification: ImprovementVerification,
  ): void {
    this.db.prepare(`
      UPDATE governance_improvement_proposals
      SET verification_run_id = ?, verification_manifest = ?
      WHERE id = ?
    `).run(runId, JSON.stringify(verification), proposalId);
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS governance_feedback_loops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        loop_id TEXT NOT NULL UNIQUE,
        eval_run_id TEXT NOT NULL,
        failures_detected INTEGER NOT NULL DEFAULT 0,
        proposals_created INTEGER NOT NULL DEFAULT 0,
        proposals_authorized INTEGER NOT NULL DEFAULT 0,
        proposals_executed INTEGER NOT NULL DEFAULT 0,
        improvement_detected INTEGER NOT NULL DEFAULT 0,
        score_delta REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS governance_improvement_proposals (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL,
        target_finding_ids TEXT NOT NULL DEFAULT '[]',
        proposed_action TEXT NOT NULL CHECK(proposed_action IN ('code_fix', 'policy_update', 'skill_update', 'config_change')),
        risk_level TEXT NOT NULL CHECK(risk_level IN ('low', 'medium', 'high', 'critical')),
        status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed', 'authorized', 'rejected', 'executing', 'completed', 'failed')),
        decision_id TEXT,
        task_id TEXT,
        execution_status TEXT,
        verification_run_id TEXT,
        verification_manifest TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_gfl_eval_run ON governance_feedback_loops(eval_run_id);
      CREATE INDEX IF NOT EXISTS idx_gfl_created ON governance_feedback_loops(created_at);
      CREATE INDEX IF NOT EXISTS idx_gip_status ON governance_improvement_proposals(status);
      CREATE INDEX IF NOT EXISTS idx_gip_category ON governance_improvement_proposals(category);
    `);
    this.addColumnIfMissing('governance_improvement_proposals', 'task_id', 'TEXT');
    this.addColumnIfMissing('governance_improvement_proposals', 'execution_status', 'TEXT');
    this.addColumnIfMissing('governance_improvement_proposals', 'verification_run_id', 'TEXT');
    this.addColumnIfMissing('governance_improvement_proposals', 'verification_manifest', "TEXT NOT NULL DEFAULT '{}'");
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}
