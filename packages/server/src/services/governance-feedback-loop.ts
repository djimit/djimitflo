/**
 * GovernanceFeedbackLoopService — closes the loop between governance assessment
 * and autonomous improvement.
 *
 * Architecture:
 *   OpenMythos (detect failure) → PolicyDecisionService (authorize fix) → pending dispatch
 *
 * The service:
 * 1. Analyzes OpenMythos eval results to identify failing categories
 * 2. Creates improvement proposals for governance failures
 * 3. Uses the canonical PolicyDecisionService and ApprovalService
 * 4. Leaves authorized work pending until dispatch is implemented through
 *    ExecutionEngine.executeTask. Direct spawn/worktree dispatch is forbidden.
 * 5. Re-runs OpenMythos to verify improvement
 * 6. Records the full feedback loop in governance_feedback_loops table
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { ApprovalRequestType, PolicyDecision, RiskLevel, type AuthTokenPayload, type RiskAssessment, type Task } from '@djimitflo/shared';
import { PolicyDecisionService } from './policy-decision-service';
import type { ApprovalService } from './approval-service';

export interface ProposalAuthorizationDecision {
  decision_id: string;
  decision: PolicyDecision;
  reason: string;
  matched_policies: string[];
  approval_id?: string;
}

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
  status: 'proposed' | 'authorized' | 'authorized_pending_dispatch' | 'rejected' | 'executing' | 'completed' | 'failed';
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
  created_at?: string;
}

export interface FeedbackLoopConfig {
  min_score_threshold: number;
  auto_authorize_below_risk: RiskLevel;
  max_proposals_per_cycle: number;
  require_verification: boolean;
  enable_dormant_capability_detection: boolean;
  dormant_capability_threshold_days: number;
}

const DEFAULT_CONFIG: FeedbackLoopConfig = {
  min_score_threshold: 3.0,
  auto_authorize_below_risk: RiskLevel.MEDIUM,
  max_proposals_per_cycle: 5,
  require_verification: true,
  enable_dormant_capability_detection: true,
  dormant_capability_threshold_days: 30,
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
    private policyDecisionService = new PolicyDecisionService(db),
    private approvalService?: ApprovalService,
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
   * Authorize proposals via the canonical policy and approval services.
   */
  authorizeProposals(
    proposals: ImprovementProposal[],
    principal: AuthTokenPayload,
  ): Array<{ proposal: ImprovementProposal; decision: ProposalAuthorizationDecision }> {
    const results: Array<{ proposal: ImprovementProposal; decision: ProposalAuthorizationDecision }> = [];

    for (const proposal of proposals) {
      const assessment: RiskAssessment = {
        action_type: 'task_execution',
        risk_level: proposal.risk_level,
        matched_rules: ['governance-feedback-proposal'],
        explanation: `Governance ${proposal.proposed_action} proposed by ${principal.sub}`,
        recommended_decision: principal.role === 'viewer' ? 'deny' : proposal.risk_level === RiskLevel.LOW ? 'allow' : 'require_approval',
        metadata: {
          proposal_id: proposal.id,
          category: proposal.category,
          target_findings: proposal.target_finding_ids,
          principal_id: principal.sub,
        },
      };
      const evaluation = this.policyDecisionService.evaluate(assessment);
      const decision: ProposalAuthorizationDecision = {
        decision_id: `dec-${randomUUID()}`,
        decision: evaluation.decision,
        reason: evaluation.explanation,
        matched_policies: evaluation.matchingPolicies.map(policy => policy.id),
      };

      if (decision.decision === 'allow') {
        proposal.status = 'authorized';
        proposal.decision_id = decision.decision_id;
      } else if (decision.decision === 'deny') {
        proposal.status = 'rejected';
      } else {
        if (this.approvalService) {
          const task = this.ensureProposalTask(proposal, principal.sub);
          decision.approval_id = this.approvalService.createApproval({
            task,
            assessment,
            requestType: ApprovalRequestType.HIGH_RISK_ACTION,
            title: proposal.title,
            description: proposal.description,
            policyId: evaluation.matchingPolicies[0]?.id,
            requestedBy: principal.sub,
            metadata: { proposal_id: proposal.id, decision_id: decision.decision_id },
          }).id;
        }
      }

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

    const autoExecutable = authorized.filter(
      ({ proposal }) =>
        proposal.status === 'authorized' &&
        proposal.risk_level <= this.config.auto_authorize_below_risk
    );

    for (const { proposal } of autoExecutable) {
      proposal.status = 'authorized_pending_dispatch';
      this.persistProposal(proposal);
    }

    const result: FeedbackLoopResult = {
      loop_id: loopId,
      eval_run_id: failures[0]?.case_ids[0] || '',
      failures_detected: failures.length,
      proposals_created: proposals.length,
      proposals_authorized: authorized.filter(a => a.proposal.status === 'authorized').length,
      proposals_executed: 0,
      improvement_detected: false,
      score_delta: 0,
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

  private ensureProposalTask(proposal: ImprovementProposal, principalId: string): Task {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO tasks
        (id, title, description, status, priority, risk_level, execution_mode, tags, metadata, created_at, updated_at)
      VALUES (?, ?, ?, 'awaiting_approval', ?, ?, 'review_only', ?, ?, ?, ?)
    `).run(
      proposal.id,
      proposal.title,
      proposal.description,
      proposal.risk_level,
      proposal.risk_level,
      JSON.stringify(['governance-feedback']),
      JSON.stringify({ proposal_id: proposal.id, requested_by: principalId }),
      now,
      now,
    );
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(proposal.id) as any;
    return {
      ...row,
      tags: JSON.parse(row.tags || '[]'),
      metadata: JSON.parse(row.metadata || '{}'),
      created_by: row.created_by || principalId,
      owner_user_id: row.owner_user_id || principalId,
      updated_by: row.updated_by || null,
    } as Task;
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

  private persistProposal(proposal: ImprovementProposal): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO governance_improvement_proposals
        (id, title, description, category, target_finding_ids, proposed_action, risk_level, status, decision_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  private ensureTables(): void {
    const table = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'governance_improvement_proposals'").get() as { sql?: string } | undefined;
    if (table?.sql && !table.sql.includes('authorized_pending_dispatch')) {
      this.db.exec(`
        ALTER TABLE governance_improvement_proposals RENAME TO governance_improvement_proposals_legacy;
        CREATE TABLE governance_improvement_proposals (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL,
          target_finding_ids TEXT NOT NULL DEFAULT '[]', proposed_action TEXT NOT NULL,
          risk_level TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'proposed'
            CHECK(status IN ('proposed', 'authorized', 'authorized_pending_dispatch', 'rejected', 'executing', 'completed', 'failed')),
          decision_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO governance_improvement_proposals
          SELECT * FROM governance_improvement_proposals_legacy;
        DROP TABLE governance_improvement_proposals_legacy;
      `);
    }
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
        status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed', 'authorized', 'authorized_pending_dispatch', 'rejected', 'executing', 'completed', 'failed')),
        decision_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_gfl_eval_run ON governance_feedback_loops(eval_run_id);
      CREATE INDEX IF NOT EXISTS idx_gfl_created ON governance_feedback_loops(created_at);
      CREATE INDEX IF NOT EXISTS idx_gip_status ON governance_improvement_proposals(status);
      CREATE INDEX IF NOT EXISTS idx_gip_category ON governance_improvement_proposals(category);
    `);
  }
}
