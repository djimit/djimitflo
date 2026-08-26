import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { RiskLevel } from '@djimitflo/shared';
import { CommandRiskClassifier } from '../services/command-risk-classifier';
import { PolicyDecisionService } from '../services/policy-decision-service';

describe('canonical policy invariants', () => {
  const db = new Database(':memory:');

  afterEach(() => db.exec('DROP TABLE IF EXISTS approval_policies'));

  it('requires approval for an unknown command', () => {
    const result = new CommandRiskClassifier().classify('unrecognized-tool --mutate');
    expect(result.recommended_decision).toBe('require_approval');
    expect(result.matched_rules).toContain('fallback-unknown-command');
  });

  it('denies a tool blocked by the matching policy', () => {
    db.exec(`
      CREATE TABLE approval_policies (
        id TEXT, name TEXT, priority INTEGER, enabled INTEGER, action_type TEXT,
        risk_level TEXT, risk_levels TEXT, decision TEXT, blocked_tools TEXT,
        allowed_tools TEXT, protected_paths TEXT, tool_patterns TEXT,
        file_patterns TEXT, metadata TEXT, match_pattern TEXT,
        require_reason INTEGER, created_at TEXT, requires_approval INTEGER
      );
      INSERT INTO approval_policies VALUES (
        'deny-shell', 'Deny shell', 100, 1, 'mcp_tool_call', 'high', '["high"]',
        'allow', '["shell"]', '[]', '[]', '[]', '[]', '{}', NULL, 0,
        '2026-08-26T00:00:00.000Z', 0
      );
    `);

    const result = new PolicyDecisionService(db).evaluate({
      action_type: 'mcp_tool_call',
      risk_level: RiskLevel.HIGH,
      matched_rules: [],
      explanation: 'test',
      recommended_decision: 'allow',
      metadata: { tool: 'shell' },
    });

    expect(result.decision).toBe('deny');
    expect(result.explanation).toContain("Tool 'shell' is blocked");
    expect(result.matchingPolicies).toHaveLength(1);
  });

  it('does not deny an allowed or unspecified tool', () => {
    db.exec(`
      CREATE TABLE approval_policies (
        id TEXT, name TEXT, priority INTEGER, enabled INTEGER, action_type TEXT,
        risk_level TEXT, risk_levels TEXT, decision TEXT, blocked_tools TEXT,
        allowed_tools TEXT, protected_paths TEXT, tool_patterns TEXT,
        file_patterns TEXT, metadata TEXT, match_pattern TEXT,
        require_reason INTEGER, created_at TEXT, requires_approval INTEGER
      );
      INSERT INTO approval_policies VALUES (
        'allow-tools', 'Allow tools', 100, 1, 'mcp_tool_call', 'high', '["high"]',
        'allow', '["shell"]', '[]', '[]', '[]', '[]', '{}', NULL, 0,
        '2026-08-26T00:00:00.000Z', 0
      );
    `);
    const service = new PolicyDecisionService(db);
    const assessment = {
      action_type: 'mcp_tool_call' as const,
      risk_level: RiskLevel.HIGH,
      matched_rules: [],
      explanation: 'test',
      recommended_decision: 'allow' as const,
      metadata: {},
    };

    expect(service.evaluate({ ...assessment, metadata: { tool: 'read_file' } }).decision).toBe('allow');
    expect(service.evaluate(assessment).decision).toBe('allow');
  });
});
