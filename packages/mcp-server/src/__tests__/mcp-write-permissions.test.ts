import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { UserRole } from '@djimitflo/shared';
import { registerGovernanceTools } from '../tools/governance.js';
import { registerExplainerTools } from '../tools/explainer.js';
import { runWithMcpAuth } from '../auth-context.js';
import { fullSchema } from '../database/schema.js';

/**
 * MCP tools that write must ask for the same permission as their HTTP twin (docs/research/mcp-a2a/SECURITY_GAPS.md S1, S2).
 * Before this fix a viewer (the stdio default role) could overwrite the /mcp-permissions catalog decisions and enqueue an
 * explainer scan of any local_path or remote_url, while the API routes need manage:config / write:governance.
 */
type Handler = (input?: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
const handlers = (server: McpServer) => (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;

function asRole<T>(role: UserRole, work: () => T): T {
  return runWithMcpAuth({ payload: { sub: `test-${role}`, role, email: `${role}@test`, iat: 0, exp: 9999999999 }, token: 'fixture' }, work);
}

describe('MCP write tools require the permission of their HTTP route twin', () => {
  let db: Database.Database;
  let server: McpServer;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO system_state VALUES ('database_instance_id', 'perm-test-db');
      CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, name TEXT, description TEXT, status TEXT, command TEXT, args TEXT, env TEXT,
        url TEXT, version TEXT, last_ping_at TEXT, error_message TEXT, metadata TEXT DEFAULT '{}', created_at TEXT, updated_at TEXT);
      CREATE TABLE mcp_tools (id TEXT PRIMARY KEY, server_id TEXT, name TEXT, description TEXT, permission TEXT, risk_level TEXT,
        input_schema TEXT, metadata TEXT DEFAULT '{}', created_at TEXT, updated_at TEXT);
      CREATE TABLE mcp_tool_permissions (id TEXT PRIMARY KEY, tool_id TEXT, decision TEXT, risk_level TEXT, reason TEXT,
        last_seen_at TEXT, metadata TEXT DEFAULT '{}', created_at TEXT, updated_at TEXT);
    `);
    db.exec(fullSchema); // explainer tables; the mcp_* tables above win (IF NOT EXISTS)
    server = new McpServer({ name: 'perm-test', version: '0' });
    registerGovernanceTools(server, { db, mode: 'live', close: () => db.close() });
    registerExplainerTools(server, db);
  });

  afterEach(() => db.close());

  it('refuses a viewer catalog sync that would overwrite an operator permission decision', async () => {
    const tools = handlers(server);
    // the operator set this decision on /mcp-permissions (PATCH needs manage:config)
    db.prepare(`INSERT INTO mcp_tool_permissions (id, tool_id, decision, risk_level, reason)
      VALUES ('djimitflo-runtime:djimitflo_sync_mcp_catalog:permission', 'djimitflo-runtime:djimitflo_sync_mcp_catalog', 'denied', 'high', 'operator')`).run();

    await expect(asRole(UserRole.VIEWER, () => tools.djimitflo_sync_mcp_catalog.handler({ apply: true })))
      .rejects.toThrow('MCP_PERMISSION_DENIED: manage:config');
    await expect(asRole(UserRole.MAKER, () => tools.djimitflo_sync_http_sidecar_catalog.handler({ apply: true })))
      .rejects.toThrow('MCP_PERMISSION_DENIED: manage:config');
    await expect(asRole(UserRole.CHECKER, () => tools.djimitflo_probe_mcp_sidecars.handler({ apply: true })))
      .rejects.toThrow('MCP_PERMISSION_DENIED: manage:config');
    expect(db.prepare('SELECT decision, reason FROM mcp_tool_permissions').all()).toEqual([{ decision: 'denied', reason: 'operator' }]);
  });

  it('keeps the read-only preview open to a viewer and lets an admin apply', async () => {
    const tools = handlers(server);
    const preview = await asRole(UserRole.VIEWER, () => tools.djimitflo_sync_mcp_catalog.handler({ apply: false }));
    expect(JSON.parse(preview.content[0].text)).toMatchObject({ apply: false });
    const applied = await asRole(UserRole.ADMIN, () => tools.djimitflo_sync_mcp_catalog.handler({ apply: true }));
    expect(JSON.parse(applied.content[0].text)).toMatchObject({ apply: true });
  });

  it('refuses explainer task creation and runs without write:governance and writes nothing', async () => {
    const tools = handlers(server);
    for (const role of [UserRole.VIEWER, UserRole.MAKER, UserRole.APPROVER]) {
      const created = await asRole(role, () => tools.explainer_create_task.handler({ title: 'x', local_path: '/data' }));
      expect(created.isError, role).toBe(true);
      expect(created.content[0].text).toContain('MCP_PERMISSION_DENIED: write:governance');
      const run = await asRole(role, () => tools.explainer_run_task.handler({ id: 'task-any' }));
      expect(run.isError, role).toBe(true);
      expect(run.content[0].text).toContain('MCP_PERMISSION_DENIED: write:governance');
    }
    expect(db.prepare('SELECT COUNT(*) AS c FROM explainer_tasks').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM explainer_jobs').get()).toEqual({ c: 0 });
  });
});
