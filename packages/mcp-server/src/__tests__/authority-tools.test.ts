import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAuthorityTools } from '../tools/authority.js';

const temporary: string[] = [];

function makeServer() {
  const dir = mkdtempSync(join(tmpdir(), 'authority-test-'));
  temporary.push(dir);
  const db = new Database(join(dir, 'test.sqlite'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE authority_events (
      id TEXT PRIMARY KEY,
      api_version TEXT NOT NULL DEFAULT 'djimit.io/v1alpha1',
      kind TEXT NOT NULL DEFAULT 'LifecycleEvent',
      event_id TEXT NOT NULL UNIQUE,
      correlation_id TEXT NOT NULL,
      causation_id TEXT,
      sequence INTEGER NOT NULL,
      occurred_at TEXT NOT NULL,
      actor_subject TEXT NOT NULL,
      actor_type TEXT NOT NULL CHECK(actor_type IN ('human','agent','service','ci')),
      actor_issuer TEXT NOT NULL DEFAULT 'djimitflo',
      artifact_id TEXT NOT NULL,
      artifact_version INTEGER NOT NULL DEFAULT 1,
      artifact_digest TEXT,
      previous_state TEXT,
      requested_state TEXT NOT NULL,
      policy_decision TEXT NOT NULL CHECK(policy_decision IN ('ALLOW','DENY','HOLD')),
      payload_digest TEXT NOT NULL,
      payload_json TEXT,
      evidence_refs_json TEXT NOT NULL DEFAULT '[]',
      source_system TEXT NOT NULL DEFAULT 'djimitflo',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(correlation_id, sequence)
    );
    CREATE INDEX idx_authority_events_correlation ON authority_events(correlation_id, sequence);

    CREATE TABLE loop_runs (
      id TEXT PRIMARY KEY, loop_name TEXT, mode TEXT DEFAULT 'closed',
      status TEXT DEFAULT 'created', created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, completed_at TEXT, metadata TEXT DEFAULT '{}'
    );
    CREATE TABLE approvals (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT DEFAULT 'pending',
      risk_level TEXT DEFAULT 'low', request_type TEXT DEFAULT 'high_risk_action',
      request_data TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE capability_tokens (
      token_ref TEXT PRIMARY KEY, risk_class TEXT DEFAULT 'low',
      status TEXT DEFAULT 'active', approved_by TEXT, expires_at TEXT,
      metadata TEXT DEFAULT '{}', updated_at TEXT NOT NULL
    );
    CREATE TABLE policy_violations (
      id TEXT PRIMARY KEY, task_id TEXT, action_type TEXT NOT NULL,
      risk_level TEXT NOT NULL, status TEXT NOT NULL,
      description TEXT NOT NULL, metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);
  const server = new McpServer({ name: 'authority-test', version: '0' });
  registerAuthorityTools(server, { db, mode: 'live' } as never);
  return { server, db };
}

type ToolBox = Record<
  string,
  { handler: (input?: unknown) => Promise<{ content: Array<{ text: string }> }> }
>;

type JsonContent = { content: Array<{ text: string }> };

function toolsOf(server: McpServer): ToolBox {
  return (server as unknown as { _registeredTools: ToolBox })._registeredTools;
}

function parse(result: JsonContent): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe('authority ledger MCP tool contracts', () => {
  it('exposes trace, emit and stats tools', () => {
    const { server } = makeServer();
    const tools = toolsOf(server);
    expect(tools).toHaveProperty('djimitflo_authority_trace');
    expect(tools).toHaveProperty('djimitflo_authority_emit');
    expect(tools).toHaveProperty('djimitflo_authority_stats');
  });

  it('emits lifecycle events and traces them back with summary', async () => {
    const { server } = makeServer();
    const tools = toolsOf(server);

    const emit = await tools.djimitflo_authority_emit.handler({
      correlationId: 'corr-e2e-1',
      previousState: 'DRAFT',
      requestedState: 'NORMALIZED',
      policyDecision: 'HOLD',
      actorSubject: 'test-runner',
      actorType: 'ci',
      artifactId: 'art-1',
      payload: { topic: 'authority' },
    });
    const emitted = parse(emit);
    expect(emitted.emitted).toBe(true);
    expect(emitted.sequence).toBe(1);
    expect(String(emitted.payload_digest)).toMatch(/^sha256:[a-f0-9]{64}$/);

    const emit2 = await tools.djimitflo_authority_emit.handler({
      correlationId: 'corr-e2e-1',
      previousState: 'NORMALIZED',
      requestedState: 'POLICY_VALIDATED',
      policyDecision: 'ALLOW',
      actorSubject: 'gate',
      artifactId: 'art-1',
    });
    const second = parse(emit2);
    expect(second.sequence).toBe(2);

    const trace = await tools.djimitflo_authority_trace.handler({
      correlationId: 'corr-e2e-1',
    });
    const t = parse(trace);
    expect(t.ledger_events).toBe(2);
    const summary = t.summary as Record<string, unknown>;
    expect(summary.last_decision).toBe('ALLOW');
    expect(summary.last_state).toBe('POLICY_VALIDATED');

    const stats = await tools.djimitflo_authority_stats.handler({});
    const s = parse(stats);
    expect(s.total).toBe(2);
  });
});

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});