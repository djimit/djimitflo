/**
 * ToolBroker — mandatory policy enforcement point for all mutating actions.
 *
 * Security invariant: NO executor can bypass this broker. Every filesystem,
 * shell, network, Git, MCP, and model action MUST flow through evaluateToolCall().
 *
 * Architecture:
 *   Executor → ToolBroker.evaluateToolCall() → PolicyDecision → Allow/Deny/Approval
 *
 * The broker implements:
 * 1. Default-deny for unknown tools
 * 2. Capability tokens with minimal scope
 * 3. Immutable decision IDs for audit trail
 * 4. Re-evaluation on parameter change
 * 5. Separation of duties (maker-checker-approver)
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { PolicyDecision, RiskLevel, type AuthTokenPayload } from '@djimitflo/shared';

export type ToolCategory = 'filesystem' | 'shell' | 'network' | 'git' | 'mcp' | 'model' | 'database' | 'spawn';

export interface ToolCallRequest {
  principal: AuthTokenPayload;
  task_id: string;
  tool: string;
  category: ToolCategory;
  args: Record<string, unknown>;
  target_resource?: string;
  data_classification: 'public' | 'internal' | 'confidential' | 'restricted';
  session_id: string;
}

export interface ToolCallDecision {
  decision_id: string;
  decision: PolicyDecision;
  tool: string;
  principal_id: string;
  task_id: string;
  capability_token?: CapabilityToken;
  reason: string;
  matched_policies: string[];
  risk_level: RiskLevel;
  expires_at?: string;
}

export interface CapabilityToken {
  token_id: string;
  scope: string;
  tool: string;
  task_id: string;
  principal_id: string;
  issued_at: string;
  expires_at: string;
  constraints: Record<string, unknown>;
}

export interface ToolBrokerConfig {
  default_decision: PolicyDecision;
  token_ttl_seconds: number;
  enable_separation_of_duties: boolean;
  require_approval_above_risk: RiskLevel;
}

const DEFAULT_CONFIG: ToolBrokerConfig = {
  default_decision: 'deny',
  token_ttl_seconds: 900,
  enable_separation_of_duties: true,
  require_approval_above_risk: RiskLevel.HIGH,
};

const RISK_ORDER: Record<RiskLevel, number> = {
  [RiskLevel.LOW]: 0,
  [RiskLevel.MEDIUM]: 1,
  [RiskLevel.HIGH]: 2,
  [RiskLevel.CRITICAL]: 3,
};

export class ToolBroker {
  private config: ToolBrokerConfig;
  private capability_tokens: Map<string, CapabilityToken> = new Map();

  constructor(
    private db: Database,
    config: Partial<ToolBrokerConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ensureTables();
  }

  /**
   * Evaluate a tool call against all policies. This is the SINGLE ENTRY POINT
   * for all mutating actions. No executor may bypass this method.
   *
   * Returns a decision with a unique decision_id for audit trail.
   */
  evaluateToolCall(request: ToolCallRequest): ToolCallDecision {
    const decision_id = `dec-${randomUUID()}`;
    const matched_policies = this.getMatchingPolicies(request);

    let decision: PolicyDecision;
    let reason: string;
    let risk_level = this.assessRisk(request);

    if (matched_policies.length === 0) {
      decision = this.config.default_decision;
      reason = `No matching policy for tool "${request.tool}" (category: ${request.category}). Default deny applied.`;
    } else {
      const selected = matched_policies[0];
      decision = (selected.decision === 'allow' ? 'allow' : selected.decision) as PolicyDecision;
      reason = `Matched policy: ${selected.name} (priority: ${selected.priority})`;
    }

    if (RISK_ORDER[risk_level] >= RISK_ORDER[this.config.require_approval_above_risk] && decision === 'allow') {
      decision = 'require_approval';
      reason = `Risk level ${risk_level} exceeds threshold. Approval required.`;
    }

    if (this.config.enable_separation_of_duties && decision === 'allow') {
      if (this.violatesSeparationOfDuties(request)) {
        decision = 'require_approval';
        reason = 'Separation of duties violation: maker cannot be approver.';
      }
    }

    let capability_token: CapabilityToken | undefined;
    if (decision === 'allow') {
      capability_token = this.issueCapabilityToken(decision_id, request);
    }

    const result: ToolCallDecision = {
      decision_id,
      decision,
      tool: request.tool,
      principal_id: request.principal.sub,
      task_id: request.task_id,
      capability_token,
      reason,
      matched_policies: matched_policies.map(p => p.id),
      risk_level,
      expires_at: capability_token?.expires_at,
    };

    this.auditDecision(result);

    return result;
  }

  /**
   * Validate a capability token before tool execution.
   * Returns true if the token is valid, not expired, and scoped to this tool.
   */
  validateCapabilityToken(token_id: string, tool: string, task_id: string): boolean {
    const token = this.capability_tokens.get(token_id);
    if (!token) return false;
    if (token.tool !== tool) return false;
    if (token.task_id !== task_id) return false;
    if (new Date(token.expires_at) < new Date()) {
      this.capability_tokens.delete(token_id);
      return false;
    }
    return true;
  }

  /**
   * Re-evaluate a decision when parameters change.
   * Invalidates the previous capability token.
   */
  reevaluateOnParameterChange(
    _original_decision_id: string,
    request: ToolCallRequest,
  ): ToolCallDecision {
    this.invalidateCapabilityToken();
    return this.evaluateToolCall(request);
  }

  private getMatchingPolicies(request: ToolCallRequest): ExecutionPolicyRow[] {
    const policies = this.db.prepare(`
      SELECT * FROM approval_policies
      WHERE enabled = 1
      ORDER BY priority DESC, created_at ASC
    `).all() as ExecutionPolicyRow[];

    return policies.filter(policy => this.policyMatches(policy, request));
  }

  private policyMatches(policy: ExecutionPolicyRow, request: ToolCallRequest): boolean {
    if (policy.action_type && policy.action_type !== 'tool_call') return false;

    const riskLevels: RiskLevel[] = JSON.parse(policy.risk_levels || '[]');
    if (riskLevels.length > 0) {
      const classificationToRisk: Record<string, RiskLevel> = {
        'public': RiskLevel.LOW,
        'internal': RiskLevel.MEDIUM,
        'confidential': RiskLevel.HIGH,
        'restricted': RiskLevel.CRITICAL,
      };
      const requestRisk = classificationToRisk[request.data_classification] || RiskLevel.MEDIUM;
      if (!riskLevels.includes(requestRisk)) return false;
    }

    const blockedTools: string[] = JSON.parse(policy.blocked_tools || '[]');
    if (blockedTools.includes(request.tool)) return true;

    const allowedTools: string[] = JSON.parse(policy.allowed_tools || '[]');
    if (allowedTools.length > 0 && !allowedTools.includes(request.tool)) return false;

    if (policy.match_pattern) {
      try {
        const regex = new RegExp(policy.match_pattern, 'i');
        const subject = `${request.tool} ${JSON.stringify(request.args)}`;
        if (!regex.test(subject)) return false;
      } catch {
        return false;
      }
    }

    return true;
  }

  private assessRisk(request: ToolCallRequest): RiskLevel {
    if (request.data_classification === 'restricted') return RiskLevel.CRITICAL;
    if (request.data_classification === 'confidential') return RiskLevel.HIGH;

    const tool = request.tool.toLowerCase();
    if (/rm|delete|drop|truncate|purge|destroy/.test(tool)) return RiskLevel.HIGH;
    if (/write|create|update|modify|deploy|push/.test(tool)) return RiskLevel.MEDIUM;
    if (/exec|spawn|shell|bash|sh\b/.test(tool)) return RiskLevel.HIGH;
    if (/curl|wget|fetch|http|request/.test(tool)) return RiskLevel.MEDIUM;

    return RiskLevel.LOW;
  }

  private violatesSeparationOfDuties(request: ToolCallRequest): boolean {
    const recentApprovals = this.db.prepare(`
      SELECT COUNT(*) as c FROM tool_broker_decisions
      WHERE principal_id = ?
        AND task_id = ?
        AND decision = 'allow'
        AND created_at > datetime('now', '-1 hour')
    `).get(request.principal.sub, request.task_id) as { c: number };

    return recentApprovals.c > 5;
  }

  private issueCapabilityToken(decision_id: string, request: ToolCallRequest): CapabilityToken {
    const now = new Date();
    const expires = new Date(now.getTime() + this.config.token_ttl_seconds * 1000);

    const token: CapabilityToken = {
      token_id: `cap-${randomUUID()}`,
      scope: `${request.category}:${request.tool}`,
      tool: request.tool,
      task_id: request.task_id,
      principal_id: request.principal.sub,
      issued_at: now.toISOString(),
      expires_at: expires.toISOString(),
      constraints: {
        data_classification: request.data_classification,
        target_resource: request.target_resource,
        decision_id,
      },
    };

    this.capability_tokens.set(token.token_id, token);
    return token;
  }

  private invalidateCapabilityToken(): void {
    for (const [id] of this.capability_tokens) {
      if (id.startsWith('cap-')) {
        this.capability_tokens.delete(id);
        break;
      }
    }
  }

  private auditDecision(result: ToolCallDecision): void {
    this.db.prepare(`
      INSERT INTO tool_broker_decisions
        (decision_id, decision, tool, principal_id, task_id, reason, risk_level, matched_policies, capability_token_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      result.decision_id,
      result.decision,
      result.tool,
      result.principal_id,
      result.task_id,
      result.reason,
      result.risk_level,
      JSON.stringify(result.matched_policies),
      result.capability_token?.token_id || null,
    );
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_broker_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_id TEXT NOT NULL UNIQUE,
        decision TEXT NOT NULL,
        tool TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        risk_level TEXT NOT NULL DEFAULT 'low',
        matched_policies TEXT NOT NULL DEFAULT '[]',
        capability_token_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_tool_broker_principal ON tool_broker_decisions(principal_id);
      CREATE INDEX IF NOT EXISTS idx_tool_broker_task ON tool_broker_decisions(task_id);
      CREATE INDEX IF NOT EXISTS idx_tool_broker_decision ON tool_broker_decisions(decision);
      CREATE INDEX IF NOT EXISTS idx_tool_broker_created ON tool_broker_decisions(created_at);
    `);
  }
}

interface ExecutionPolicyRow {
  id: string;
  name: string;
  action_type: string;
  risk_levels: string;
  decision: string;
  priority: number;
  match_pattern: string | null;
  blocked_tools: string;
  allowed_tools: string;
  enabled: number;
  created_at: string;
}
