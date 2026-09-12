import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { UserRole } from '@djimitflo/shared';
import { registerOrchestrationTools } from '../tools/orchestration.js';
import { runWithMcpAuth } from '../auth-context.js';
import type { DbHandle } from '../db.js';

describe('legacy spawn_agent registration contract', () => {
  let handle: DbHandle;
  let tool: any;
  const input = { task: 'Review a disposable fixture', runtime: 'codex', role: 'checker', context_budget: 4000, parent_run_id: 'requested-parent' };
  const authenticated = (role = UserRole.MAKER) => runWithMcpAuth({
    payload: { sub: 'fixture-maker', email: 'maker@test', role, iat: 1, exp: 9999999999 }, token: 'fixture-only',
  }, () => tool.handler(input));

  beforeEach(() => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO system_state VALUES ('database_instance_id', 'registration-fixture');
      CREATE TABLE agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('idle','active','paused','error','offline','pending_approval')),
        capabilities TEXT NOT NULL, model TEXT, metadata TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE tasks (id TEXT PRIMARY KEY);
      CREATE TABLE worker_leases (id TEXT PRIMARY KEY);
    `);
    handle = { db, mode: 'live', close: () => db.close() };
    const server = new McpServer({ name: 'registration-fixture', version: '1' });
    registerOrchestrationTools(server, handle);
    tool = (server as any)._registeredTools.djimitflo_spawn_agent;
  });
  afterEach(() => handle.close());

  it('reports only persisted registration, with no task, lease, execution or allocated context', async () => {
    const result = JSON.parse((await authenticated()).content[0].text);
    expect(result).toMatchObject({ status: 'idle', registration_only: true, execution_started: false, context_budget_enforced: false });
    expect(tool.description).toMatch(/registration.only/i);
    expect(result.message).toMatch(/no.*execution/i);
    expect(result.message).not.toMatch(/monitor progress|sub-agent spawned/i);
    const row = handle.db.prepare('SELECT * FROM agents WHERE id = ?').get(result.agent_id) as any;
    expect(row.status).toBe(result.status);
    expect(row.model).toBeNull();
    expect(JSON.parse(row.metadata)).toMatchObject({ requested_runtime: 'codex', context_budget: 4000, context_budget_enforced: false, parent_run_id: 'requested-parent', spawned_by: 'fixture-maker', registration_only: true });
    expect(handle.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 0 });
    expect(handle.db.prepare('SELECT COUNT(*) AS n FROM worker_leases').get()).toEqual({ n: 0 });
  });

  it('registers distinct idle agents for repeated role/runtime requests under the real unique-name constraint', async () => {
    const first = JSON.parse((await authenticated()).content[0].text);
    const second = JSON.parse((await authenticated()).content[0].text);
    expect(first.agent_id).not.toBe(second.agent_id);
    expect(handle.db.prepare('SELECT COUNT(*) AS n FROM agents').get()).toEqual({ n: 2 });
  });

  it('preserves anonymous, unauthorized and snapshot write boundaries', async () => {
    await expect(tool.handler(input)).rejects.toThrow('MCP_AUTH_CONTEXT_REQUIRED');
    await expect(authenticated(UserRole.VIEWER)).rejects.toThrow('MCP_PERMISSION_DENIED');
    handle.mode = 'snapshot';
    await expect(authenticated()).rejects.toThrow('DJIMITFLO_LIVE_DATA_REQUIRED');
    expect(handle.db.prepare('SELECT COUNT(*) AS n FROM agents').get()).toEqual({ n: 0 });
  });
});
