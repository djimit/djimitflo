import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../../packages/mcp-server/dist/index.js';
import { startHttpServer } from '../../packages/mcp-server/dist/transports/http.js';

const apiBase = 'http://127.0.0.1:3187/api';
process.env.DJIMITFLO_API_URL = apiBase;
const secret = process.env.AUDIT_JWT_SECRET;
assert(secret, 'Provide the disposable local fixture JWT secret through AUDIT_JWT_SECRET');
const login = await fetch(`${apiBase}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'audit@example.test', password: 'disposable-local-audit-only' }),
}).then(response => response.json());
assert(login.token, 'Local fixture login failed');
const headers = { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' };
const db = new Database(resolve(import.meta.dirname, '../../.data/audit.sqlite'));
const mcp = new McpServer({ name: 'audit-local-smoke', version: '1' });
registerTools(mcp, { db, mode: 'live', close: () => {} });
const server = await startHttpServer(mcp, 0, secret, '127.0.0.1');
const client = new Client({ name: 'audit-sdk-client', version: '1' });
const evidence = { generated_at: new Date().toISOString(), state: 'FAIL', transport: 'real SDK SSE over loopback', secrets_recorded: false };
try {
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  await client.connect(new SSEClientTransport(url, { requestInit: { headers } }), { timeout: 5000 });
  const listed = await client.listTools();
  evidence.tool_count = listed.tools.length;
  const taskResponse = await fetch(`${apiBase}/tasks`, { method: 'POST', headers, body: JSON.stringify({ title: 'MCP transport audit fixture', description: 'Review-only disposable local integration proof', use_swarm_context: false, execution_mode: 'review_only' }) });
  assert.equal(taskResponse.status, 201);
  const task = await taskResponse.json();
  evidence.task_id = task.id;
  const result = await client.callTool({ name: 'djimitflo_approve_action', arguments: { task_id: task.id, action: 'Review local audit artifact', reason: 'Prove authenticated MCP to REST persistence without dispatch', risk_level: 'low', context: { audit_fixture: true } } });
  assert(!result.isError, JSON.stringify(result));
  const approvalId = JSON.parse(result.content[0].text).approval_id;
  const approvalResponse = await fetch(`${apiBase}/approvals/${approvalId}`, { headers });
  assert.equal(approvalResponse.status, 200);
  const approval = await approvalResponse.json();
  assert.equal(approval.task_id, task.id);
  assert.equal(approval.status, 'pending');
  assert.equal(approval.requested_by, login.user.id);
  assert.equal(approval.metadata.manual_action, true);
  assert(Date.parse(approval.expires_at) > Date.now());
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id).status, 'pending');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE resource_id = ? AND event_type = 'approval.requested'").get(approvalId).n, 1);
  evidence.approval_id = approvalId;
  evidence.state = 'PASS';
  evidence.proven = ['SDK initialize/list/tools-call transport', 'Authenticated principal forwarded', 'Task-bound approval persisted and readable over REST', 'Expiry and manual-action marker', 'Audit request stored', 'Task not dispatched'];
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await client.close();
  await mcp.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  db.close();
  writeFileSync(resolve(import.meta.dirname, process.env.AUDIT_MCP_REPORT || 'evidence/mcp-live-smoke.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence));
}
