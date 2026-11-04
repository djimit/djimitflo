import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from './helpers/test-db';
import type { Database } from 'better-sqlite3';
import { ToolBroker, RateLimitExceeded } from '../services/tool-broker';
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
