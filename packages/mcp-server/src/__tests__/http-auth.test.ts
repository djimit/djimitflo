import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { UserRole } from '@djimitflo/shared';
import { startHttpServer } from '../transports/http.js';
import { registerOrchestrationTools } from '../tools/orchestration.js';
import { runWithMcpAuth } from '../auth-context.js';

function token(secret: string, sub = 'maker-1') {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub, email: 'a@test', role: 'maker', iat: 1, exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
  return `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
}

describe('MCP HTTP authentication', () => {
  const servers: import('http').Server[] = [];
  afterEach(async () => Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))));

  it('keeps health public but rejects MCP dispatch without a bearer token', async () => {
    const server = await startHttpServer(new McpServer({ name: 'test', version: '1' }), 0, 'test-secret');
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('listener unavailable');
    expect((await fetch(`http://127.0.0.1:${address.port}/health`)).status).toBe(200);
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'AUTH_REQUIRED' });
  });

  it('rejects an invalid bearer token before MCP dispatch', async () => {
    const server = await startHttpServer(new McpServer({ name: 'test', version: '1' }), 0, 'test-secret');
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('listener unavailable');
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, { headers: { authorization: 'Bearer invalid.jwt.token' } });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'INVALID_TOKEN' });
  });

  it('records the verified principal on approval requests', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO system_state VALUES ('database_instance_id','test-db');
      CREATE TABLE approvals (id TEXT PRIMARY KEY, task_id TEXT, status TEXT, risk_level TEXT, request_type TEXT, request_message TEXT, request_data TEXT, requested_by TEXT, created_at TEXT);
    `);
    const mcp = new McpServer({ name: 'test', version: '1' });
    registerOrchestrationTools(mcp, { db, mode: 'live', close: () => db.close() });
    const tool = (mcp as any)._registeredTools.djimitflo_approve_action;
    const now = Math.floor(Date.now() / 1000);

    await runWithMcpAuth({ payload: { sub: 'maker-1', email: 'a@test', role: UserRole.MAKER, iat: now, exp: now + 60 }, token: token('secret') },
      () => tool.handler({ action: 'deploy', reason: 'release', risk_level: 'high', context: {} }));

    expect((db.prepare('SELECT requested_by FROM approvals').get() as { requested_by: string }).requested_by).toBe('maker-1');
    db.close();
  });
});
