import type { Database } from 'better-sqlite3';
import { ExecutionPolicy, PolicyDecision, RiskAssessment, RiskLevel } from '@djimitflo/shared';

export interface PolicyEvaluationResult {
  decision: PolicyDecision;
  matchingPolicies: ExecutionPolicy[];
  explanation: string;
}

export class PolicyDecisionService {
  constructor(private db: Database) {}

  getPolicies(): ExecutionPolicy[] {
    const rows = this.db.prepare('SELECT * FROM approval_policies ORDER BY priority DESC, created_at DESC').all() as any[];
    return rows.map((row) => this.mapPolicy(row));
  }

  evaluate(assessment: RiskAssessment): PolicyEvaluationResult {
    const policies = this.getPolicies().filter((policy) => policy.enabled);
    const matchingPolicies = policies.filter((policy) => this.matches(policy, assessment));

    if (matchingPolicies.length === 0) {
      return {
        decision: assessment.recommended_decision,
        matchingPolicies: [],
        explanation: 'No explicit policy matched. Falling back to classifier recommendation.',
      };
    }

    const selected = matchingPolicies[0];
    return {
      decision: selected.decision,
      matchingPolicies,
      explanation: `Matched policy: ${selected.name}`,
    };
  }

  private matches(policy: ExecutionPolicy, assessment: RiskAssessment): boolean {
    if (policy.action_type && policy.action_type !== assessment.action_type) {
      return false;
    }

    const policyRiskLevels = policy.risk_levels && policy.risk_levels.length > 0
      ? policy.risk_levels
      : [policy.risk_level];

    if (!policyRiskLevels.includes(assessment.risk_level)) {
      return false;
    }

    if (policy.match_pattern) {
      const pattern = new RegExp(policy.match_pattern, 'i');
      const subject = JSON.stringify(assessment.metadata);
      if (!pattern.test(subject)) {
        return false;
      }
    }

    return true;
  }

  private mapPolicy(row: any): ExecutionPolicy {
    const riskLevels = JSON.parse(row.risk_levels || '[]');
    return {
      ...row,
      action_type: row.action_type || 'unknown',
      decision: row.decision || (row.requires_approval ? 'require_approval' : 'allow'),
      risk_level: row.risk_level || riskLevels[0] || RiskLevel.MEDIUM,
      match_pattern: row.match_pattern || null,
      protected_paths: JSON.parse(row.protected_paths || '[]'),
      allowed_tools: JSON.parse(row.allowed_tools || '[]'),
      blocked_tools: JSON.parse(row.blocked_tools || '[]'),
      require_reason: Boolean(row.require_reason),
      metadata: JSON.parse(row.metadata || '{}'),
      risk_levels: riskLevels,
      tool_patterns: JSON.parse(row.tool_patterns || '[]'),
      file_patterns: JSON.parse(row.file_patterns || '[]'),
      enabled: Boolean(row.enabled),
    };
  }
}
