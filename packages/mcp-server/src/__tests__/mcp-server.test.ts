import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import type { DbHandle } from '../db.js';
import { registerTools } from '../index.js';

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
      description TEXT, agent_type TEXT, capabilities TEXT DEFAULT '[]', capabilities_json TEXT DEFAULT '[]',
      model TEXT, last_seen TEXT, last_heartbeat_at TEXT, last_active_at TEXT, metadata TEXT DEFAULT '{}',
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
      overall_score REAL DEFAULT 0, status TEXT DEFAULT 'pending', judge_model TEXT,
      categories_json TEXT DEFAULT '[]', metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE openmythos_case_results (id TEXT PRIMARY KEY, run_id TEXT);
    CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE mcp_servers (
      id TEXT PRIMARY KEY, name TEXT, description TEXT, status TEXT, command TEXT, args TEXT,
      url TEXT, version TEXT, last_ping_at TEXT, error_message TEXT, metadata TEXT DEFAULT '{}', updated_at TEXT
    );
    CREATE TABLE mcp_tools (
      id TEXT PRIMARY KEY, server_id TEXT, name TEXT, description TEXT, permission TEXT, risk_level TEXT,
      input_schema TEXT, metadata TEXT DEFAULT '{}', total_calls INTEGER DEFAULT 0,
      successful_calls INTEGER DEFAULT 0, failed_calls INTEGER DEFAULT 0, last_called_at TEXT, updated_at TEXT
    );
    CREATE TABLE mcp_tool_permissions (
      id TEXT PRIMARY KEY, tool_id TEXT, policy_id TEXT, decision TEXT, risk_level TEXT,
      reason TEXT, last_seen_at TEXT, updated_at TEXT
    );
    CREATE TABLE tasks (id TEXT PRIMARY KEY, updated_at TEXT);
    CREATE TABLE execution_evidence (id TEXT PRIMARY KEY, task_id TEXT, created_at TEXT);
    CREATE TABLE execution_events (id TEXT PRIMARY KEY, task_id TEXT, created_at TEXT);
    CREATE TABLE approvals (id TEXT PRIMARY KEY, task_id TEXT, created_at TEXT);
    CREATE TABLE swarm_evidence_edges (id TEXT PRIMARY KEY, from_ref TEXT, to_ref TEXT, created_at TEXT);
    CREATE TABLE token_usage_log (
      id TEXT PRIMARY KEY, task_id TEXT, provider TEXT, model TEXT, prompt_tokens INTEGER,
      completion_tokens INTEGER, total_tokens INTEGER, cost REAL
    );
    CREATE TABLE skill_outcomes (
      id TEXT PRIMARY KEY, skill_id TEXT, success INTEGER, tokens_used INTEGER, duration_ms INTEGER,
      domain TEXT, task_id TEXT, agent_id TEXT, skill_version TEXT, skill_content_hash TEXT,
      model TEXT, evidence_refs_json TEXT, created_at TEXT
    );
  `);
  return { db, close: () => db.close() };
}

function createTestServer(dbHandle: DbHandle): McpServer {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerTools(server, dbHandle);
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
    expect(toolNames).toContain('djimitflo_get_data_provenance');
    expect(toolNames).toContain('notebook_list');
    expect(toolNames).toContain('explainer_create_task');
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

  it('exercises every critical read-only governance and orchestration contract', async () => {
    const tools = (server as any)._registeredTools;
    const calls: Array<[string, Record<string, unknown>]> = [
      ['djimitflo_mcp_doctor', {}],
      ['djimitflo_sync_mcp_catalog', { apply: false }],
      ['djimitflo_sync_http_sidecar_catalog', { apply: false }],
      ['djimitflo_probe_mcp_sidecars', { apply: false }],
      ['djimitflo_list_mcp_servers', {}],
      ['djimitflo_list_mcp_tools', {}],
      ['djimitflo_get_mcp_permissions', {}],
      ['djimitflo_get_cost_summary', {}],
      ['djimitflo_get_evidence_chain', { taskId: 'missing' }],
      ['djimitflo_list_openmythos_runs', {}],
      ['djimitflo_list_skill_outcomes', {}],
      ['djimitflo_list_orchestration_agents', {}],
    ];

    for (const [name, input] of calls) {
      const result = await tools[name].handler(input);
      expect(result.content[0].text, name).toBeDefined();
    }
  });

  it('keeps critical mutating MCP contracts fail-closed on snapshot data', async () => {
    const tools = (server as any)._registeredTools;
    const calls: Array<[string, Record<string, unknown>]> = [
      ['djimitflo_sync_mcp_catalog', { apply: true }],
      ['djimitflo_sync_http_sidecar_catalog', { apply: true }],
      ['djimitflo_probe_mcp_sidecars', { apply: true }],
      ['djimitflo_spawn_agent', { task: 'test', runtime: 'mock', role: 'maker', context_budget: 500 }],
      ['djimitflo_handoff_agent', { from_node_id: 'a', to_node_id: 'b', agent_id: 'agent', lease_id: 'lease', summary: 'test', artifacts: [] }],
    ];

    for (const [name, input] of calls) {
      await expect(tools[name].handler(input), name).rejects.toThrow('DJIMITFLO_LIVE_DATA_REQUIRED');
    }
  });
});
