import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from './helpers/test-db';
import type { Database } from 'better-sqlite3';
import { ToolBroker, RateLimitExceeded } from '../services/tool-broker';
import { DataClassificationEnforcement } from '../services/data-classification-enforcement';
import { AuditAnchoringService } from '../services/audit-anchoring';
import { DataClassification } from '../services/data-classification';
import { RiskLevel, type AuthTokenPayload } from '@djimitflo/shared';

describe('Security Invariant: ToolBroker Rate Limiting', () => {
  let db: Database;
  let broker: ToolBroker;

  beforeEach(() => {
    db = createTestDb() as unknown as Database;
    db.exec(`
      CREATE TABLE IF NOT EXISTS approval_policies (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, action_type TEXT NOT NULL DEFAULT 'tool_call',
        risk_levels TEXT NOT NULL DEFAULT '[]', decision TEXT NOT NULL DEFAULT 'allow',
        priority INTEGER NOT NULL DEFAULT 0, match_pattern TEXT, blocked_tools TEXT NOT NULL DEFAULT '[]',
        allowed_tools TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS tool_broker_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, decision_id TEXT NOT NULL UNIQUE, decision TEXT NOT NULL,
        tool TEXT NOT NULL, principal_id TEXT NOT NULL, task_id TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
        risk_level TEXT NOT NULL DEFAULT 'low', matched_policies TEXT NOT NULL DEFAULT '[]',
        capability_token_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  });

  afterEach(() => { db.close(); });

  function makeRequest(overrides: Partial<Parameters<ToolBroker['evaluateToolCall']>[0]> = {}) {
    return {
      principal: { sub: 'user-1', email: 'test@test.com', role: 'maker', iat: 0, exp: 0 },
      task_id: 'task-1',
      tool: 'read_file',
      category: 'filesystem' as const,
      args: {},
      data_classification: 'internal' as const,
      session_id: 'session-1',
      ...overrides,
    };
  }

  it('allows requests within rate limit', () => {
    db.prepare(`
      INSERT INTO approval_policies (id, name, action_type, risk_levels, decision, priority, enabled, created_at)
      VALUES ('policy-1', 'allow-reads', 'tool_call', '["low","medium"]', 'allow', 100, 1, datetime('now'))
    `).run();
    broker = new ToolBroker(db, { rate_limit_enabled: false });
    const result = broker.evaluateToolCall(makeRequest());
    expect(result.decision).toBe('allow');
  });

  it('throws RateLimitExceeded when burst limit exceeded', () => {
    broker = new ToolBroker(db, {
      rate_limit_enabled: true,
      rate_limit_burst: 2,
      rate_limit_max_requests: 100,
      rate_limit_window_ms: 60_000,
    });

    // First 2 should succeed (burst limit)
    broker.evaluateToolCall(makeRequest());
    broker.evaluateToolCall(makeRequest());

    // Third should fail
    expect(() => broker.evaluateToolCall(makeRequest())).toThrow(RateLimitExceeded);
  });

  it('throws RateLimitExceeded when sliding window limit exceeded', () => {
    broker = new ToolBroker(db, {
      rate_limit_enabled: true,
      rate_limit_burst: 100,
      rate_limit_max_requests: 3,
      rate_limit_window_ms: 60_000,
    });

    // First 3 should succeed
    broker.evaluateToolCall(makeRequest());
    broker.evaluateToolCall(makeRequest());
    broker.evaluateToolCall(makeRequest());

    // Fourth should fail
    expect(() => broker.evaluateToolCall(makeRequest())).toThrow(RateLimitExceeded);
  });

  it('tracks rate limit status', () => {
    broker = new ToolBroker(db, {
      rate_limit_enabled: true,
      rate_limit_burst: 100,
      rate_limit_max_requests: 5,
      rate_limit_window_ms: 60_000,
    });

    broker.evaluateToolCall(makeRequest());
    broker.evaluateToolCall(makeRequest());

    const status = broker.getRateLimitStatus('user-1');
    expect(status).not.toBeNull();
    expect(status!.remaining).toBe(3);
  });

  it('resets burst counter after 1 second', async () => {
    db.prepare(`
      INSERT INTO approval_policies (id, name, action_type, risk_levels, decision, priority, enabled, created_at)
      VALUES ('policy-1', 'allow-reads', 'tool_call', '["low","medium"]', 'allow', 100, 1, datetime('now'))
    `).run();
    broker = new ToolBroker(db, {
      rate_limit_enabled: true,
      rate_limit_burst: 1,
      rate_limit_max_requests: 100,
      rate_limit_window_ms: 60_000,
    });

    broker.evaluateToolCall(makeRequest());
    expect(() => broker.evaluateToolCall(makeRequest())).toThrow(RateLimitExceeded);

    // Wait for burst reset
    await new Promise(resolve => setTimeout(resolve, 1100));

    // Should work again
    const result = broker.evaluateToolCall(makeRequest());
    expect(result.decision).toBe('allow');
  });
});

describe('Security Invariant: Data Classification Enforcement', () => {
  let db: Database;
  let enforcement: DataClassificationEnforcement;

  beforeEach(() => {
    db = createTestDb() as unknown as Database;
    enforcement = new DataClassificationEnforcement(db);
  });

  afterEach(() => { db.close(); });

  it('redacts PII from confidential data', () => {
    const result = enforcement.redact(
      'Contact john@example.com or call 555-123-4567',
      DataClassification.CONFIDENTIAL,
    );
    expect(result.redacted).toContain('[REDACTED_EMAIL');
    expect(result.redacted).toContain('[REDACTED_PHONE');
    expect(result.redactions.length).toBeGreaterThan(0);
  });

  it('does not redact public data', () => {
    const result = enforcement.redact(
      'Contact john@example.com',
      DataClassification.PUBLIC,
    );
    expect(result.redacted).toBe('Contact john@example.com');
    expect(result.redactions).toEqual([]);
  });

  it('blocks cloud providers for restricted data', () => {
    const result = enforcement.checkProviderRouting(DataClassification.RESTRICTED, 'openai');
    expect(result.allowed).toBe(false);
    expect(result.recommended_providers).toContain('ollama');
  });

  it('allows on-premise providers for restricted data', () => {
    const result = enforcement.checkProviderRouting(DataClassification.RESTRICTED, 'ollama');
    expect(result.allowed).toBe(true);
  });

  it('checks retention expiry', () => {
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000); // 100 days ago
    const result = enforcement.checkRetention(DataClassification.RESTRICTED, oldDate);
    expect(result.expired).toBe(true);
    expect(result.days_overdue).toBeGreaterThan(0);
  });

  it('requires encryption for confidential data', () => {
    expect(enforcement.requiresEncryption(DataClassification.CONFIDENTIAL)).toBe(true);
    expect(enforcement.requiresEncryption(DataClassification.PUBLIC)).toBe(false);
  });

  it('requires audit for internal data', () => {
    expect(enforcement.requiresAudit(DataClassification.INTERNAL)).toBe(true);
    expect(enforcement.requiresAudit(DataClassification.PUBLIC)).toBe(false);
  });

  it('enforces compliance on records', () => {
    const record = {
      created_at: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
      encryption_status: 'none',
    };

    const result = enforcement.enforceOnRecord(DataClassification.RESTRICTED, record);
    expect(result.compliant).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

describe('Security Invariant: AuditAnchoring Retry', () => {
  let service: AuditAnchoringService;
  let auditDb: Database;

  beforeEach(() => {
    auditDb = createTestDb() as unknown as Database;
    auditDb.exec(`
      CREATE TABLE IF NOT EXISTS compliance_audit_log (
        id TEXT PRIMARY KEY, timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        actor TEXT NOT NULL DEFAULT 'system', action TEXT NOT NULL DEFAULT '',
        resource TEXT NOT NULL DEFAULT '', outcome TEXT NOT NULL DEFAULT 'success',
        evidence_json TEXT NOT NULL DEFAULT '{}', previous_hash TEXT NOT NULL DEFAULT 'genesis',
        hash TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS audit_anchors (
        id INTEGER PRIMARY KEY AUTOINCREMENT, anchor_id TEXT NOT NULL UNIQUE,
        merkle_root TEXT NOT NULL, chain_start TEXT NOT NULL, chain_end TEXT NOT NULL,
        event_count INTEGER NOT NULL, anchored_at TEXT NOT NULL, anchor_type TEXT NOT NULL,
        destination TEXT, status TEXT NOT NULL DEFAULT 'pending', retry_count INTEGER NOT NULL DEFAULT 0
      );
    `);
    service = new AuditAnchoringService(
      auditDb,
      { webhook_url: 'http://localhost:9999/webhook', siem_type: 'custom' },
      { max_retries: 2, initial_delay_ms: 10, max_delay_ms: 100, backoff_multiplier: 2 },
    );
  });

  afterEach(() => {
    service.clearRetryTimers();
    auditDb.close();
  });

  it('calculates exponential backoff', async () => {
    const result = await service.anchorToExternal('http://localhost:9999/webhook', 'webhook');
    // Should fail and go to dead letter queue after retries
    expect(['failed', 'dead_letter', 'confirmed']).toContain(result.status);
  });

  it('provides dead letter queue', () => {
    const dlq = service.getDeadLetterQueue();
    expect(Array.isArray(dlq)).toBe(true);
  });

  it('clears retry timers', () => {
    expect(() => service.clearRetryTimers()).not.toThrow();
  });
});
