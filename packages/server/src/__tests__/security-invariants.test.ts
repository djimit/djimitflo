import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/test-db';
import type { Database } from 'better-sqlite3';
import { ToolBroker, type ToolCallRequest } from '../services/tool-broker';
import { WorktreeManager } from '../services/worktree-manager';

describe('Security Invariant: ToolBroker', () => {
  let db: Database;
  let broker: ToolBroker;

  beforeEach(() => {
    db = createTestDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS approval_policies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        action_type TEXT NOT NULL DEFAULT 'tool_call',
        risk_levels TEXT NOT NULL DEFAULT '[]',
        decision TEXT NOT NULL DEFAULT 'allow',
        priority INTEGER NOT NULL DEFAULT 0,
        match_pattern TEXT,
        blocked_tools TEXT NOT NULL DEFAULT '[]',
        allowed_tools TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    broker = new ToolBroker(db);
  });

  afterEach(() => {
    db.close();
  });

  function makeRequest(overrides: Partial<ToolCallRequest> = {}): ToolCallRequest {
    return {
      principal: { sub: 'user-1', email: 'test@test.com', role: 'maker', iat: 0, exp: 0 },
      task_id: 'task-1',
      tool: 'read_file',
      category: 'filesystem',
      args: { path: '/workspace/file.txt' },
      data_classification: 'internal',
      session_id: 'session-1',
      ...overrides,
    };
  }

  it('defaults deny for unknown tools', () => {
    const decision = broker.evaluateToolCall(makeRequest({ tool: 'unknown_tool_xyz' }));
    expect(decision.decision).toBe('deny');
    expect(decision.decision_id).toMatch(/^dec-/);
  });

  it('generates unique decision IDs for audit trail', () => {
    const d1 = broker.evaluateToolCall(makeRequest({ tool: 'read' }));
    const d2 = broker.evaluateToolCall(makeRequest({ tool: 'read' }));
    expect(d1.decision_id).not.toBe(d2.decision_id);
  });

  it('issues capability tokens for allowed low-risk actions', () => {
    db.prepare(`
      INSERT INTO approval_policies (id, name, action_type, risk_levels, decision, priority, enabled, created_at)
      VALUES ('policy-1', 'allow-reads', 'tool_call', '["medium"]', 'allow', 100, 1, datetime('now'))
    `).run();

    const decision = broker.evaluateToolCall(makeRequest({ tool: 'read_file', data_classification: 'internal' }));
    expect(decision.capability_token).toBeDefined();
    expect(decision.capability_token?.tool).toBe('read_file');
    expect(decision.capability_token?.task_id).toBe('task-1');
  });

  it('escalates to approval for critical data classification even with allow policy', () => {
    db.prepare(`
      INSERT INTO approval_policies (id, name, action_type, risk_levels, decision, priority, enabled, created_at)
      VALUES ('policy-all', 'allow-all', 'tool_call', '["low","medium","high","critical"]', 'allow', 100, 1, datetime('now'))
    `).run();

    const decision = broker.evaluateToolCall(makeRequest({
      tool: 'read_file',
      data_classification: 'restricted',
    }));
    expect(decision.decision).toBe('require_approval');
    expect(decision.risk_level).toBe('critical');
  });

  it('validates capability tokens correctly', () => {
    db.prepare(`
      INSERT INTO approval_policies (id, name, action_type, risk_levels, decision, priority, enabled, created_at)
      VALUES ('policy-1', 'allow-reads', 'tool_call', '["medium"]', 'allow', 100, 1, datetime('now'))
    `).run();

    const decision = broker.evaluateToolCall(makeRequest({ tool: 'read_file', data_classification: 'internal' }));
    const token = decision.capability_token!;

    expect(broker.validateCapabilityToken(token.token_id, 'read_file', 'task-1')).toBe(true);
    expect(broker.validateCapabilityToken(token.token_id, 'write_file', 'task-1')).toBe(false);
    expect(broker.validateCapabilityToken(token.token_id, 'read_file', 'task-2')).toBe(false);
    expect(broker.validateCapabilityToken('invalid-token', 'read_file', 'task-1')).toBe(false);
  });

  it('audits all decisions to the database', () => {
    broker.evaluateToolCall(makeRequest({ tool: 'test_audit' }));
    const row = db.prepare('SELECT COUNT(*) as c FROM tool_broker_decisions WHERE tool = ?').get('test_audit') as any;
    expect(row.c).toBe(1);
  });

  it('assesses shell tools as high risk', () => {
    const decision = broker.evaluateToolCall(makeRequest({
      tool: 'exec',
      category: 'shell',
      data_classification: 'internal',
    }));
    expect(decision.risk_level).toBe('high');
  });

  it('assesses destructive tools as high risk', () => {
    const decision = broker.evaluateToolCall(makeRequest({
      tool: 'rm_rf',
      category: 'shell',
      data_classification: 'internal',
    }));
    expect(decision.risk_level).toBe('high');
  });

  it('reattributes decisions on parameter change', () => {
    db.prepare(`
      INSERT INTO approval_policies (id, name, action_type, risk_levels, decision, priority, enabled, created_at)
      VALUES ('policy-1', 'allow-reads', 'tool_call', '["medium"]', 'allow', 100, 1, datetime('now'))
    `).run();

    const original = broker.evaluateToolCall(makeRequest({ data_classification: 'internal' }));
    const reevaluated = broker.reevaluateOnParameterChange(original.decision_id, makeRequest({ tool: 'write_file' }));
    expect(reevaluated.decision_id).not.toBe(original.decision_id);
  });
});

describe('Security Invariant: WorktreeManager Safety', () => {
  let db: Database;
  let manager: WorktreeManager;

  beforeEach(() => {
    db = createTestDb();
    manager = new WorktreeManager(db);
  });

  afterEach(() => {
    db.close();
  });

  it('rejects paths outside worktree root', () => {
    expect(manager.isPathAllowed('/etc/passwd')).toBe(false);
    expect(manager.isPathAllowed('/tmp/malicious')).toBe(false);
  });

  it('sanitizes finding IDs', () => {
    const sanitized = manager.sanitizeFindingId('../../../etc/passwd');
    expect(sanitized).not.toContain('/');
    expect(sanitized).not.toContain('..');
    expect(manager.sanitizeFindingId('normal-id')).toBe('normal-id');
    expect(manager.sanitizeFindingId('a'.repeat(100))).toHaveLength(64);
  });

  it('validates worktree safety for non-existent repo', () => {
    const result = manager.validateWorktreeSafety('/non/existent/path', '/tmp/some/path');
    expect(result.safe).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('rejects path traversal in worktree paths', () => {
    const worktreeRoot = process.env.LOOP_WORKTREE_ROOT || '/repo/.djimitflo-loop-worktrees';
    const malicious = `${worktreeRoot}/../../../etc/passwd`;
    expect(manager.isPathAllowed(malicious)).toBe(false);
  });
});

describe('Security Invariant: Compliance Audit Append-Only', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('blocks UPDATE on compliance_audit_log', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS compliance_audit_log (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        actor TEXT NOT NULL DEFAULT 'system',
        action TEXT NOT NULL DEFAULT '',
        resource TEXT NOT NULL DEFAULT '',
        outcome TEXT NOT NULL DEFAULT 'success' CHECK(outcome IN ('success', 'failure', 'denied')),
        evidence_json TEXT NOT NULL DEFAULT '{}',
        previous_hash TEXT NOT NULL DEFAULT 'genesis',
        hash TEXT NOT NULL DEFAULT ''
      );

      CREATE TRIGGER IF NOT EXISTS compliance_audit_no_update
        BEFORE UPDATE ON compliance_audit_log
        FOR EACH ROW
        BEGIN
          SELECT RAISE(FAIL, 'compliance_audit_log is append-only');
        END;
    `);

    db.prepare(`
      INSERT INTO compliance_audit_log (id, timestamp, action, actor, resource, outcome, previous_hash, hash)
      VALUES ('test-1', datetime('now'), 'test_action', 'test_actor', 'test_resource', 'success', 'genesis', 'abc123')
    `).run();

    expect(() => {
      db.prepare("UPDATE compliance_audit_log SET action = 'tampered' WHERE id = 'test-1'").run();
    }).toThrow();
  });

  it('blocks DELETE on compliance_audit_log', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS compliance_audit_log (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        actor TEXT NOT NULL DEFAULT 'system',
        action TEXT NOT NULL DEFAULT '',
        resource TEXT NOT NULL DEFAULT '',
        outcome TEXT NOT NULL DEFAULT 'success' CHECK(outcome IN ('success', 'failure', 'denied')),
        evidence_json TEXT NOT NULL DEFAULT '{}',
        previous_hash TEXT NOT NULL DEFAULT 'genesis',
        hash TEXT NOT NULL DEFAULT ''
      );

      CREATE TRIGGER IF NOT EXISTS compliance_audit_no_delete
        BEFORE DELETE ON compliance_audit_log
        FOR EACH ROW
        BEGIN
          SELECT RAISE(FAIL, 'compliance_audit_log is append-only');
        END;
    `);

    db.prepare(`
      INSERT INTO compliance_audit_log (id, timestamp, action, actor, resource, outcome, previous_hash, hash)
      VALUES ('test-1', datetime('now'), 'test_action', 'test_actor', 'test_resource', 'success', 'genesis', 'abc123')
    `).run();

    expect(() => {
      db.prepare("DELETE FROM compliance_audit_log WHERE id = 'test-1'").run();
    }).toThrow();
  });

  it('allows INSERT on compliance_audit_log', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS compliance_audit_log (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        actor TEXT NOT NULL DEFAULT 'system',
        action TEXT NOT NULL DEFAULT '',
        resource TEXT NOT NULL DEFAULT '',
        outcome TEXT NOT NULL DEFAULT 'success' CHECK(outcome IN ('success', 'failure', 'denied')),
        evidence_json TEXT NOT NULL DEFAULT '{}',
        previous_hash TEXT NOT NULL DEFAULT 'genesis',
        hash TEXT NOT NULL DEFAULT ''
      );

      CREATE TRIGGER IF NOT EXISTS compliance_audit_no_update
        BEFORE UPDATE ON compliance_audit_log
        FOR EACH ROW
        BEGIN
          SELECT RAISE(FAIL, 'compliance_audit_log is append-only');
        END;

      CREATE TRIGGER IF NOT EXISTS compliance_audit_no_delete
        BEFORE DELETE ON compliance_audit_log
        FOR EACH ROW
        BEGIN
          SELECT RAISE(FAIL, 'compliance_audit_log is append-only');
        END;
    `);

    expect(() => {
      db.prepare(`
        INSERT INTO compliance_audit_log (id, timestamp, action, actor, resource, outcome, previous_hash, hash)
        VALUES ('test-1', datetime('now'), 'test_action', 'test_actor', 'test_resource', 'success', 'genesis', 'abc123')
      `).run();
    }).not.toThrow();

    const row = db.prepare('SELECT COUNT(*) as c FROM compliance_audit_log').get() as any;
    expect(row.c).toBe(1);
  });
});
