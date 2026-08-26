import { ReDoSGuard } from './redos-guard';
import type { Database } from 'better-sqlite3';
import { ExecutionPolicy, PolicyDecision, RiskAssessment, RiskLevel, type Task } from '@djimitflo/shared';
import { GovernanceGateService, type GateVerdict } from './governance-gate-service';

export interface PolicyEvaluationResult {
  decision: PolicyDecision;
  matchingPolicies: ExecutionPolicy[];
  explanation: string;
  governance?: GateVerdict;
}

export class PolicyDecisionService {
  private readonly governance: GovernanceGateService;

  constructor(private db: Database) {
    this.governance = new GovernanceGateService(db);
  }

  getPolicies(): ExecutionPolicy[] {
    const table = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'approval_policies'").get();
    if (!table) return [];
    const rows = this.db.prepare('SELECT * FROM approval_policies ORDER BY priority DESC, created_at DESC').all() as any[];
    return rows.map((row) => this.mapPolicy(row));
  }

  evaluate(assessment: RiskAssessment, context?: { task: Task; executorKind: string }): PolicyEvaluationResult {
    const policies = this.getPolicies().filter((policy) => policy.enabled);
    const matchingPolicies = policies.filter((policy) => this.matches(policy, assessment));
    const selected = matchingPolicies[0];
    const tool = typeof assessment.metadata.tool === 'string' ? assessment.metadata.tool : null;

    let result: PolicyEvaluationResult;
    if (!selected) {
      result = {
        decision: assessment.recommended_decision,
        matchingPolicies: [],
        explanation: 'No explicit policy matched. Falling back to classifier recommendation.',
      };
    } else {
      const blocked = tool !== null && selected.blocked_tools.includes(tool);
      result = {
        decision: blocked ? 'deny' : selected.decision,
        matchingPolicies,
        explanation: blocked ? `Tool '${tool}' is blocked by policy: ${selected.name}` : `Matched policy: ${selected.name}`,
      };
    }

    if (!context) return result;
    const governance = this.governance.assess(context.task, context.executorKind);
    return governance.action === 'require_approval' && result.decision === 'allow'
      ? { ...result, decision: 'require_approval', explanation: governance.reason, governance }
      : { ...result, governance };
  }

  private matches(policy: ExecutionPolicy, assessment: RiskAssessment): boolean {
    const policyAction = String(policy.action_type);
    if (policyAction && policyAction !== assessment.action_type &&
        !(policyAction === 'tool_call' && assessment.action_type === 'mcp_tool_call')) {
      return false;
    }

    const policyRiskLevels = policy.risk_levels && policy.risk_levels.length > 0
      ? policy.risk_levels
      : [policy.risk_level];

    if (!policyRiskLevels.includes(assessment.risk_level)) {
      return false;
    }

    if (policy.match_pattern) {
      const pattern = ReDoSGuard.compile(policy.match_pattern);
      if (!pattern) return false;
      const subject = JSON.stringify(assessment.metadata);
      if (!pattern.test(subject)) {
        return false;
      }
    }

    const tool = typeof assessment.metadata.tool === 'string' ? assessment.metadata.tool : null;
    if (tool && policy.allowed_tools.length > 0 && !policy.allowed_tools.includes(tool)) return false;
    if (tool && policy.blocked_tools.includes(tool)) return true;

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
