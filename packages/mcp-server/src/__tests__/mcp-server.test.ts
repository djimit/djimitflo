import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import type { DbHandle } from '../db.js';
import { registerLoopTools } from '../tools/loops.js';
import { registerGoalTools } from '../tools/goals.js';
import { registerAgentTools } from '../tools/agents.js';
import { registerMissionControlTools } from '../tools/mission-control.js';
import { registerOrchestrationTools } from '../tools/orchestration.js';
import { registerGovernanceTools } from '../tools/governance.js';

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
      description TEXT, agent_type TEXT, capabilities TEXT DEFAULT '[]',
      model TEXT, last_active_at TEXT, last_heartbeat_at TEXT, metadata TEXT DEFAULT '{}',
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
    CREATE TABLE fleet_handoffs (
      id TEXT PRIMARY KEY, from_node TEXT, to_node TEXT, agent_id TEXT,
      context_json TEXT DEFAULT '{}', status TEXT DEFAULT 'pending', priority TEXT DEFAULT 'medium',
      created_at TEXT NOT NULL
    );
    CREATE TABLE approvals (
      id TEXT PRIMARY KEY, task_id TEXT, execution_event_id TEXT, status TEXT,
      risk_level TEXT, request_type TEXT, request_message TEXT, request_data TEXT,
      created_at TEXT NOT NULL, updated_at TEXT
    );
    CREATE TABLE mcp_servers (
      id TEXT PRIMARY KEY, name TEXT, description TEXT,
      status TEXT CHECK(status IN ('running', 'stopped', 'error', 'unknown')),
      command TEXT, args TEXT,
      env TEXT DEFAULT '{}', version TEXT, url TEXT, last_ping_at TEXT, error_message TEXT,
      metadata TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE mcp_tools (
      id TEXT PRIMARY KEY, server_id TEXT, name TEXT, description TEXT, permission TEXT,
      risk_level TEXT, input_schema TEXT DEFAULT '{}', total_calls INTEGER DEFAULT 0,
      successful_calls INTEGER DEFAULT 0, failed_calls INTEGER DEFAULT 0, last_called_at TEXT,
      metadata TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE mcp_tool_permissions (
      id TEXT PRIMARY KEY, tool_id TEXT, policy_id TEXT, decision TEXT, risk_level TEXT,
      reason TEXT, last_seen_at TEXT, metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE token_usage_log (
      id TEXT PRIMARY KEY, task_id TEXT, provider TEXT, model TEXT,
      prompt_tokens INTEGER DEFAULT 0, completion_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0, cost REAL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE skill_outcomes (
      id TEXT PRIMARY KEY, skill_id TEXT, success INTEGER DEFAULT 0, tokens_used INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0, domain TEXT DEFAULT '', task_id TEXT, agent_id TEXT,
      skill_version TEXT, skill_content_hash TEXT, model TEXT, evidence_refs_json TEXT DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT, description TEXT, status TEXT, priority TEXT,
      risk_level TEXT, execution_mode TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE execution_evidence (
      id TEXT PRIMARY KEY, task_id TEXT, evidence_type TEXT, severity TEXT, title TEXT,
      summary TEXT, details TEXT, source TEXT, captured_at TEXT, metadata TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE execution_events (
      id TEXT PRIMARY KEY, task_id TEXT, event_type TEXT, timestamp TEXT, message TEXT,
      level TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE swarm_evidence_edges (
      id TEXT PRIMARY KEY, from_ref TEXT, to_ref TEXT, relation TEXT, metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE TABLE openmythos_eval_runs (
      id TEXT PRIMARY KEY, agent_id TEXT, started_at TEXT, finished_at TEXT, total_cases INTEGER DEFAULT 0,
      completed_cases INTEGER DEFAULT 0, overall_score REAL DEFAULT 0, status TEXT DEFAULT 'pending',
      judge_model TEXT DEFAULT 'test', created_at TEXT NOT NULL
    );
    CREATE TABLE openmythos_case_results (
      id TEXT PRIMARY KEY, run_id TEXT, case_id TEXT, category TEXT, status TEXT DEFAULT 'pending',
      created_at TEXT NOT NULL
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
  registerOrchestrationTools(server, dbHandle);
  registerGovernanceTools(server, dbHandle);
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
    vi.unstubAllGlobals();
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
    expect(toolNames).toContain('djimitflo_list_orchestration_agents');
    expect(toolNames).toContain('djimitflo_mcp_doctor');
    expect(toolNames).toContain('djimitflo_sync_mcp_catalog');
    expect(toolNames).toContain('djimitflo_sync_http_sidecar_catalog');
    expect(toolNames).toContain('djimitflo_probe_mcp_sidecars');
    expect(toolNames).toContain('djimitflo_list_mcp_servers');
    expect(toolNames).toContain('djimitflo_list_mcp_tools');
    expect(toolNames).toContain('djimitflo_get_mcp_permissions');
    expect(toolNames).toContain('djimitflo_get_cost_summary');
    expect(toolNames).toContain('djimitflo_get_evidence_chain');
    expect(toolNames).toContain('djimitflo_list_openmythos_runs');
    expect(toolNames).toContain('djimitflo_list_skill_outcomes');
    expect(toolNames.length).toBe(new Set(toolNames).size);
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

  it('governance tools return empty read-only summaries', async () => {
    const registeredTools = (server as any)._registeredTools;
    const servers = await registeredTools['djimitflo_list_mcp_servers'].handler({});
    expect(JSON.parse(servers.content[0].text)).toEqual([]);

    const cost = await registeredTools['djimitflo_get_cost_summary'].handler({});
    const parsed = JSON.parse(cost.content[0].text);
    expect(parsed.totals.rows).toBe(0);
    expect(parsed.by_model).toEqual([]);
  });

  it('mcp_doctor reports registry drift without mutating state', async () => {
    const registeredTools = (server as any)._registeredTools;
    const result = await registeredTools['djimitflo_mcp_doctor'].handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('needs_attention');
    expect(parsed.summary.current_server_tools).toBe(Object.keys(registeredTools).length);
    expect(parsed.summary.db_mcp_tools).toBe(0);
    expect(parsed.drift.current_tools_missing_registry_rows).toContain('djimitflo_mcp_doctor');
    expect(parsed.live_sidecar_handshakes.checked).toBe(false);
  });

  it('sync_mcp_catalog previews and applies runtime tool rows', async () => {
    const registeredTools = (server as any)._registeredTools;
    const toolCount = Object.keys(registeredTools).length;

    const preview = await registeredTools['djimitflo_sync_mcp_catalog'].handler({});
    const previewJson = JSON.parse(preview.content[0].text);
    expect(previewJson.apply).toBe(false);
    expect(previewJson.would_create_tools).toBe(toolCount);
    expect((dbHandle.db.prepare('SELECT COUNT(*) AS c FROM mcp_tools').get() as { c: number }).c).toBe(0);

    const applied = await registeredTools['djimitflo_sync_mcp_catalog'].handler({ apply: true });
    const appliedJson = JSON.parse(applied.content[0].text);
    expect(appliedJson.apply).toBe(true);
    expect(appliedJson.synced_tools).toBe(toolCount);
    expect((dbHandle.db.prepare('SELECT COUNT(*) AS c FROM mcp_tools WHERE server_id = ?').get('djimitflo-runtime') as { c: number }).c).toBe(toolCount);
    expect((dbHandle.db.prepare('SELECT COUNT(*) AS c FROM mcp_tool_permissions').get() as { c: number }).c).toBe(toolCount);

    const doctor = await registeredTools['djimitflo_mcp_doctor'].handler({});
    const doctorJson = JSON.parse(doctor.content[0].text);
    expect(doctorJson.drift.current_tools_missing_registry_rows).toEqual([]);
  });

  it('probe_mcp_sidecars previews by default and updates status only on apply', async () => {
    dbHandle.db.prepare(`
      INSERT INTO mcp_servers (id, name, description, status, command, args, env, url, created_at, updated_at)
      VALUES ('sidecar-1', 'sidecar', 'test sidecar', 'unknown', '', '[]', '{}', 'http://127.0.0.1:1', datetime('now'), datetime('now'))
    `).run();
    dbHandle.db.prepare(`
      INSERT INTO mcp_servers (id, name, description, status, command, args, env, url, metadata, created_at, updated_at)
      VALUES ('sidecar-3', 'path sidecar', 'test sidecar with probe path', 'unknown', '', '[]', '{}', 'http://example.test/api', '{"probe_path":"/health"}', datetime('now'), datetime('now'))
    `).run();
    dbHandle.db.prepare(`
      INSERT INTO mcp_servers (id, name, description, status, command, args, env, url, created_at, updated_at)
      VALUES ('sidecar-4', 'missing sidecar', 'test sidecar with 404', 'unknown', '', '[]', '{}', 'http://example.test/missing', datetime('now'), datetime('now'))
    `).run();
    dbHandle.db.prepare(`
      INSERT INTO mcp_servers (id, name, description, status, command, args, env, created_at, updated_at)
      VALUES ('sidecar-2', 'stdio sidecar', 'test sidecar without url', 'unknown', 'node', '[]', '{}', datetime('now'), datetime('now'))
    `).run();
    dbHandle.db.prepare(`
      INSERT INTO mcp_servers (id, name, description, status, command, args, env, metadata, created_at, updated_at)
      VALUES ('catalog-1', 'catalog sidecar', 'catalog-only tools', 'stopped', '', '[]', '{}', '{"catalog_only":true}', datetime('now'), datetime('now'))
    `).run();
    const registeredTools = (server as any)._registeredTools;

    const preview = await registeredTools['djimitflo_probe_mcp_sidecars'].handler({});
    const previewJson = JSON.parse(preview.content[0].text);
    expect(previewJson.apply).toBe(false);
    expect(previewJson.targets).toHaveLength(3);
    expect((dbHandle.db.prepare('SELECT status FROM mcp_servers WHERE id = ?').get('sidecar-1') as { status: string }).status).toBe('unknown');

    vi.stubGlobal('fetch', async (url: string) => ({ status: url.endsWith('/missing') ? 404 : 204 }));
    const applied = await registeredTools['djimitflo_probe_mcp_sidecars'].handler({ apply: true });
    const appliedJson = JSON.parse(applied.content[0].text);
    expect(appliedJson.running).toBe(2);
    expect(appliedJson.error).toBe(1);
    expect(appliedJson.results.find((row: { id: string }) => row.id === 'sidecar-3').probe_url).toBe('http://example.test/health');
    const row = dbHandle.db.prepare('SELECT status, last_ping_at, error_message FROM mcp_servers WHERE id = ?').get('sidecar-1') as {
      status: string;
      last_ping_at: string | null;
      error_message: string | null;
    };
    expect(row.status).toBe('running');
    expect(row.last_ping_at).toBeTruthy();
    expect(row.error_message).toBeNull();
    expect((dbHandle.db.prepare('SELECT status FROM mcp_servers WHERE id = ?').get('sidecar-4') as { status: string }).status).toBe('error');

    const doctor = await registeredTools['djimitflo_mcp_doctor'].handler({});
    const doctorJson = JSON.parse(doctor.content[0].text);
    expect(doctorJson.drift.servers_without_last_ping).toHaveLength(0);
    const serversWithoutProbeUrl = doctorJson.drift.servers_without_probe_url.map((row: { id: string }) => row.id);
    expect(serversWithoutProbeUrl).toContain('sidecar-2');
    expect(serversWithoutProbeUrl).not.toContain('sidecar-1');
    expect(serversWithoutProbeUrl).not.toContain('catalog-1');
    expect(doctorJson.drift.catalog_only_servers.map((row: { id: string }) => row.id)).toContain('catalog-1');
  });

  it('sync_http_sidecar_catalog previews and applies OpenAPI operations', async () => {
    dbHandle.db.prepare(`
      INSERT INTO mcp_servers (id, name, description, status, command, args, env, url, metadata, created_at, updated_at)
      VALUES ('openapi-1', 'openapi sidecar', 'test openapi sidecar', 'running', '', '[]', '{}', 'http://example.test/api', '{"openapi_path":"/openapi.json"}', datetime('now'), datetime('now'))
    `).run();
    const registeredTools = (server as any)._registeredTools;

    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        paths: {
          '/search': { get: { operationId: 'search', summary: 'Search' } },
          '/jobs': { post: { operationId: 'createJob', summary: 'Create job', requestBody: {} } },
          '/jobs/{id}': { get: { operationId: 'search', summary: 'Get job' } },
        },
      }),
    }));

    const preview = await registeredTools['djimitflo_sync_http_sidecar_catalog'].handler({});
    const previewJson = JSON.parse(preview.content[0].text);
    expect(previewJson.apply).toBe(false);
    expect(previewJson.would_sync_tools).toBe(3);
    expect((dbHandle.db.prepare('SELECT COUNT(*) AS c FROM mcp_tools WHERE server_id = ?').get('openapi-1') as { c: number }).c).toBe(0);

    const applied = await registeredTools['djimitflo_sync_http_sidecar_catalog'].handler({ apply: true });
    const appliedJson = JSON.parse(applied.content[0].text);
    expect(appliedJson.synced_tools).toBe(3);
    const tools = dbHandle.db.prepare('SELECT name, permission, risk_level FROM mcp_tools WHERE server_id = ? ORDER BY name').all('openapi-1') as Array<{ name: string; permission: string; risk_level: string }>;
    expect(tools).toEqual([
      { name: 'get_jobs_id', permission: 'allowed', risk_level: 'low' },
      { name: 'get_search', permission: 'allowed', risk_level: 'low' },
      { name: 'post_jobs', permission: 'requires_approval', risk_level: 'medium' },
    ]);
    expect((dbHandle.db.prepare('SELECT COUNT(*) AS c FROM mcp_tool_permissions WHERE tool_id LIKE ?').get('openapi-1:%') as { c: number }).c).toBe(3);

    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500 }));
    const failedRefresh = await registeredTools['djimitflo_sync_http_sidecar_catalog'].handler({ apply: true });
    const failedRefreshJson = JSON.parse(failedRefresh.content[0].text);
    expect(failedRefreshJson.synced_tools).toBe(0);
    expect(failedRefreshJson.deleted_stale_tools).toBe(0);
    expect((dbHandle.db.prepare('SELECT COUNT(*) AS c FROM mcp_tools WHERE server_id = ?').get('openapi-1') as { c: number }).c).toBe(3);
    expect((dbHandle.db.prepare('SELECT COUNT(*) AS c FROM mcp_tool_permissions WHERE tool_id LIKE ?').get('openapi-1:%') as { c: number }).c).toBe(3);

    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        paths: {
          '/search': { get: { operationId: 'search', summary: 'Search' } },
        },
      }),
    }));
    const pruned = await registeredTools['djimitflo_sync_http_sidecar_catalog'].handler({ apply: true });
    const prunedJson = JSON.parse(pruned.content[0].text);
    expect(prunedJson.synced_tools).toBe(1);
    expect(prunedJson.deleted_stale_tools).toBe(2);
    expect(dbHandle.db.prepare('SELECT name FROM mcp_tools WHERE server_id = ?').all('openapi-1')).toEqual([{ name: 'get_search' }]);
    expect((dbHandle.db.prepare('SELECT COUNT(*) AS c FROM mcp_tool_permissions WHERE tool_id LIKE ?').get('openapi-1:%') as { c: number }).c).toBe(1);
  });

  it('get_evidence_chain errors for nonexistent task', async () => {
    const registeredTools = (server as any)._registeredTools;
    const result = await registeredTools['djimitflo_get_evidence_chain'].handler({ taskId: 'missing' });
    expect(result.isError).toBe(true);
  });
});
