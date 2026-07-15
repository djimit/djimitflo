import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import type { DbHandle } from '../db.js';
import { registerLoopTools } from '../tools/loops.js';
import { registerGoalTools } from '../tools/goals.js';
import { registerAgentTools } from '../tools/agents.js';
import { registerMissionControlTools } from '../tools/mission-control.js';
import { registerOpenMythosTools } from '../tools/openmythos.js';

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
      metadata_json TEXT DEFAULT '{}', level TEXT DEFAULT 'info',
      created_at TEXT NOT NULL
    );
    CREATE TABLE openmythos_eval_runs (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
      started_at TEXT, finished_at TEXT,
      total_cases INTEGER DEFAULT 0, completed_cases INTEGER DEFAULT 0,
      overall_score REAL DEFAULT 0, status TEXT DEFAULT 'pending',
      categories_json TEXT DEFAULT '[]', metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  registerOpenMythosTools(server, dbHandle);
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

  it('registers the openmythos tools', () => {
    const toolNames = Object.keys((server as any)._registeredTools || {});
    expect(toolNames).toContain('djimitflo_openmythos_leaderboard');
    expect(toolNames).toContain('djimitflo_openmythos_score');
  });

  it('openmythos_leaderboard ranks latest completed run per agent', async () => {
    const insert = dbHandle.db.prepare(`
      INSERT INTO openmythos_eval_runs (id, agent_id, status, completed_cases, overall_score, finished_at, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    insert.run('r1', 'agent-a', 'completed', 78, 2.0, '2026-07-14T10:00:00Z', '{"category_scores":{"injection":3.0},"subject_model":"llama3.1:8b"}');
    insert.run('r2', 'agent-a', 'completed', 78, 3.5, '2026-07-15T10:00:00Z', '{"category_scores":{"injection":4.0},"subject_model":"llama3.1:8b"}');
    insert.run('r3', 'agent-b', 'completed', 78, 2.5, '2026-07-15T10:00:00Z', '{}');
    insert.run('r4', 'agent-c', 'failed', 0, 0, null, '{}');

    const tool = (server as any)._registeredTools['djimitflo_openmythos_leaderboard'];
    const result = await tool.handler({});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.map((row: { agentId: string }) => row.agentId)).toEqual(['agent-a', 'agent-b']);
    expect(parsed[0].overallScore).toBe(3.5);
    expect(parsed[0].categoryScores).toEqual({ injection: 4.0 });
    expect(parsed[0].subjectModel).toBe('llama3.1:8b');
  });

  it('openmythos_score returns latest score with trend, and errors on unknown agent', async () => {
    const insert = dbHandle.db.prepare(`
      INSERT INTO openmythos_eval_runs (id, agent_id, status, completed_cases, overall_score, finished_at, metadata, created_at)
      VALUES (?, ?, 'completed', 78, ?, ?, '{}', datetime('now'))
    `);
    insert.run('r1', 'agent-a', 2.0, '2026-07-14T10:00:00Z');
    insert.run('r2', 'agent-a', 3.0, '2026-07-15T10:00:00Z');

    const tool = (server as any)._registeredTools['djimitflo_openmythos_score'];
    const result = await tool.handler({ agentId: 'agent-a' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.overallScore).toBe(3.0);
    expect(parsed.trend.map((t: { score: number }) => t.score)).toEqual([2.0, 3.0]);

    const missing = await tool.handler({ agentId: 'nope' });
    expect(missing.isError).toBe(true);
  });
});
