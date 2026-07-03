import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import type { DbHandle } from '../db.js';
import { registerLoopTools } from '../tools/loops.js';
import { registerGoalTools } from '../tools/goals.js';
import { registerAgentTools } from '../tools/agents.js';
import { registerMissionControlTools } from '../tools/mission-control.js';

function createTestDb(): DbHandle {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE loop_runs (
      id TEXT PRIMARY KEY, loop_name TEXT, mode TEXT DEFAULT 'closed',
      status TEXT DEFAULT 'created', goal_id TEXT, repository_path TEXT,
      findings_json TEXT DEFAULT '[]', gates_json TEXT DEFAULT '[]',
      next_actions_json TEXT DEFAULT '[]', metadata_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE goals (
      id TEXT PRIMARY KEY, objective TEXT, status TEXT DEFAULT 'created',
      risk_class TEXT DEFAULT 'low', budget_json TEXT DEFAULT '{}',
      acceptance_criteria_json TEXT DEFAULT '[]', metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'idle',
      agent_type TEXT, capabilities_json TEXT DEFAULT '[]',
      last_seen TEXT, metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE worker_leases (
      id TEXT PRIMARY KEY, loop_run_id TEXT, role TEXT, runtime TEXT DEFAULT 'codex',
      status TEXT DEFAULT 'prepared', finding_id TEXT, worktree_path TEXT,
      metadata TEXT DEFAULT '{}', budget_json TEXT DEFAULT '{}',
      capability_id TEXT, parent_lease_id TEXT, spawn_tree_id TEXT,
      depth INTEGER DEFAULT 0, spawned_by_agent_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE loop_events (
      id TEXT PRIMARY KEY, loop_run_id TEXT, event_type TEXT,
      severity TEXT DEFAULT 'info', message TEXT,
      metadata_json TEXT DEFAULT '{}', created_at TEXT NOT NULL
    );
  `);
  return { db, close: () => db.close() };
}

function createTestServer(dbHandle: DbHandle): McpServer {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerLoopTools(server, dbHandle);
  registerGoalTools(server, dbHandle);
  registerAgentTools(server, dbHandle);
  registerMissionControlTools(server, dbHandle);
  return server;
}

describe('MCP Server Tools', () => {
  let dbHandle: DbHandle;
  let server: McpServer;

  beforeEach(() => {
    dbHandle = createTestDb();
    server = createTestServer(dbHandle);
  });

  afterEach(() => {
    dbHandle.close();
  });

  it('registers all expected tools', () => {
    const registeredTools = (server as any)._registeredTools;
    const toolNames = Object.keys(registeredTools || {});
    expect(toolNames).toContain('djimitflo_list_loop_runs');
    expect(toolNames).toContain('djimitflo_get_loop_status');
    expect(toolNames).toContain('djimitflo_get_loop_catalog');
    expect(toolNames).toContain('djimitflo_list_goals');
    expect(toolNames).toContain('djimitflo_get_goal');
    expect(toolNames).toContain('djimitflo_list_agents');
    expect(toolNames).toContain('djimitflo_get_agent_status');
    expect(toolNames).toContain('djimitflo_get_mission_control');
    expect(toolNames).toContain('djimitflo_get_system_health');
  });

  it('list_loop_runs returns empty array when no runs', async () => {
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools['djimitflo_list_loop_runs'];
    expect(tool).toBeDefined();
    const result = await tool.handler({});
    expect(result.content[0].text).toBeDefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(0);
  });

  it('get_loop_status returns error for nonexistent run', async () => {
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools['djimitflo_get_loop_status'];
    const result = await tool.handler({ runId: 'nonexistent' });
    expect(result.isError).toBe(true);
  });

  it('get_mission_control returns summary', async () => {
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools['djimitflo_get_mission_control'];
    const result = await tool.handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.summary).toBeDefined();
    expect(parsed.summary.activeLoans).toBe(0);
    expect(parsed.summary.pendingGoals).toBe(0);
  });
});
