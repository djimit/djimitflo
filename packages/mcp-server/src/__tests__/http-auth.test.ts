import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { UserRole } from '@djimitflo/shared';
import { startHttpServer } from '../transports/http.js';
import { registerOrchestrationTools } from '../tools/orchestration.js';
import { runWithMcpAuth } from '../auth-context.js';

function token(secret: string) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'approver-1', email: 'a@test', role: 'approver', iat: 1, exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
  return `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
}

describe('MCP HTTP authentication', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns 401 before MCP dispatch without a bearer token', async () => {
    const server = await startHttpServer(new McpServer({ name: 'test', version: '1' }), 0, 'test-secret');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('listener unavailable');
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'AUTH_REQUIRED' });
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('returns 401 for an invalid bearer token', async () => {
    const server = await startHttpServer(new McpServer({ name: 'test', version: '1' }), 0, 'test-secret');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('listener unavailable');
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, { headers: { authorization: 'Bearer invalid.jwt.token' } });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'INVALID_TOKEN' });
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('passes the verified principal token to the canonical approval API', async () => {
    const db = new Database(':memory:');
    db.exec("CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT); INSERT INTO system_state VALUES ('database_instance_id','test-db')");
    const mcp = new McpServer({ name: 'test', version: '1' });
    registerOrchestrationTools(mcp, { db, mode: 'live', close: () => db.close() });
    const accessToken = token('test-secret');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'SELF_APPROVAL_FORBIDDEN', message: 'independent approval required' } }), { status: 409, headers: { 'content-type': 'application/json' } })));
    process.env.DJIMITFLO_API_URL = 'http://api.test';
    const tool = (mcp as any)._registeredTools.djimitflo_approve_action;

    await expect(runWithMcpAuth({
      payload: { sub: 'approver-1', email: 'a@test', role: UserRole.APPROVER, iat: 1, exp: Math.floor(Date.now() / 1000) + 60 },
      token: accessToken,
    }, () => tool.handler({ approval_id: 'own-request', decision: 'approved' }))).rejects.toThrow('SELF_APPROVAL_FORBIDDEN');
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(expect.stringContaining('/api/approvals/own-request/approve'), expect.objectContaining({ headers: expect.objectContaining({ authorization: `Bearer ${accessToken}` }) }));
    delete process.env.DJIMITFLO_API_URL;
    db.close();
  });
});
