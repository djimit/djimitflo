import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { UserRole } from '@djimitflo/shared';
import { startHttpServer } from '../transports/http.js';
import { registerOrchestrationTools } from '../tools/orchestration.js';
import { currentMcpAuth, runWithMcpAuth } from '../auth-context.js';
import { createServer } from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

function token(secret: string, sub = 'maker-1', claims: Record<string, unknown> = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub, email: 'a@test', role: 'maker', iat: 1, exp: Math.floor(Date.now() / 1000) + 60, ...claims })).toString('base64url');
  return `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
}

describe('MCP HTTP authentication', () => {
  const servers: import('http').Server[] = [];
  const databases: Database.Database[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    databases.splice(0).forEach(db => db.close());
  });

  function authorityDb() {
    const db = new Database(':memory:'); databases.push(db);
    db.exec(`
      CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO system_state VALUES ('database_instance_id','session-fixture');
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, role TEXT, is_active INTEGER, organization_id TEXT);
      INSERT INTO users VALUES ('maker-1','current@test','maker',1,'assigned');
      CREATE TABLE refresh_tokens (token_hash TEXT PRIMARY KEY, user_id TEXT, session_id TEXT, revoked INTEGER, expires_at TEXT);
      INSERT INTO refresh_tokens VALUES ('synthetic-hash','maker-1','family',0,'2099-01-01T00:00:00Z');
      INSERT INTO refresh_tokens VALUES ('other-hash','maker-1','other-family',0,'2099-01-01T00:00:00Z');
      CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, description TEXT, status TEXT, capabilities TEXT, model TEXT, metadata TEXT, created_at TEXT, updated_at TEXT);
    `);
    return { db, mode: 'live' as const, close: () => {} };
  }

  it.each(['no-authority', 'snapshot', 'revoked', 'expired', 'wrong-user', 'disabled', 'stale-organization'] as const)
    ('rejects browser session with %s authority before opening an MCP stream', async condition => {
      const handle = authorityDb();
      if (condition === 'revoked') handle.db.exec('UPDATE refresh_tokens SET revoked=1');
      if (condition === 'expired') handle.db.exec("UPDATE refresh_tokens SET expires_at='2000-01-01'");
      if (condition === 'wrong-user') handle.db.exec("UPDATE refresh_tokens SET user_id='another-user'");
      if (condition === 'disabled') handle.db.exec('UPDATE users SET is_active=0');
      const authority = condition === 'no-authority' ? undefined : condition === 'snapshot' ? { ...handle, mode: 'snapshot' as const } : handle;
      const server = await startHttpServer(() => new McpServer({ name: 'session-fixture', version: '1' }), 0, 'session-secret', '127.0.0.1', authority);
      servers.push(server);
      const address = server.address() as import('net').AddressInfo;
      const bearer = token('session-secret', 'maker-1', { sid: 'family', organization_id: condition === 'stale-organization' ? 'former-org' : 'assigned' });
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, { headers: { authorization: `Bearer ${bearer}` } });
      await response.body?.cancel();
      expect(response.status).toBe(401);
    });

  it('uses current identity for direct tools and refuses a revoked family on an existing stock SDK session', async () => {
    const handle = authorityDb();
    const server = await startHttpServer(() => {
      const mcp = new McpServer({ name: 'session-fixture', version: '1' });
      registerOrchestrationTools(mcp, handle);
      mcp.registerTool('identity', { inputSchema: {} }, async () => ({ content: [{ type: 'text', text: JSON.stringify(currentMcpAuth().payload) }] }));
      return mcp;
    }, 0, 'session-secret', '127.0.0.1', handle);
    servers.push(server);
    const address = server.address() as import('net').AddressInfo;
    const client = new Client({ name: 'fixture', version: '1' });
    const bearer = token('session-secret', 'maker-1', { sid: 'family', organization_id: 'assigned', role: 'admin' });
    try {
      await client.connect(new SSEClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }));
      const identity = await client.callTool({ name: 'identity', arguments: {} });
      expect(JSON.parse((identity.content as any[])[0].text)).toMatchObject({ role: 'maker', email: 'current@test', sid: 'family' });
      const args = { task: 'Registration-only fixture', runtime: 'mock', role: 'maker', context_budget: 4000 };
      await client.callTool({ name: 'djimitflo_spawn_agent', arguments: args });
      expect(handle.db.prepare('SELECT COUNT(*) AS n FROM agents').get()).toEqual({ n: 1 });
      handle.db.exec("UPDATE refresh_tokens SET revoked=1 WHERE session_id='family'");
      await expect(client.callTool({ name: 'djimitflo_spawn_agent', arguments: args })).rejects.toThrow();
      expect(handle.db.prepare('SELECT COUNT(*) AS n FROM agents').get()).toEqual({ n: 1 });
    } finally { await client.close(); }
  });

  it.each(['sid', 'organization_id'])('does not permit replacing %s on an existing MCP session', async field => {
    const handle = authorityDb();
    const server = await startHttpServer(() => new McpServer({ name: 'session-fixture', version: '1' }), 0, 'session-secret', '127.0.0.1', handle);
    servers.push(server);
    const address = server.address() as import('net').AddressInfo;
    const client = new Client({ name: 'fixture', version: '1' });
    let endpoint = '';
    const claims = { sid: 'family', organization_id: 'assigned' };
    try {
      await client.connect(new SSEClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token('session-secret', 'maker-1', claims)}` } },
        fetch: async (input, init) => { if (init?.method === 'POST') endpoint = String(input); return fetch(input, init); },
      }));
      const changed = { ...claims, [field]: field === 'sid' ? 'other-family' : 'default' };
      const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token('session-secret', 'maker-1', changed)}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
      expect(response.status).toBe(403);
    } finally { await client.close(); }
  });

  it('serves concurrent stock SSE clients and prevents cross-principal session reuse', async () => {
    const server = await startHttpServer(() => {
      const mcp = new McpServer({ name: 'session-test', version: '1' });
      mcp.registerTool('identity', { inputSchema: {} }, async () => ({ content: [{ type: 'text', text: currentMcpAuth().payload.sub }] }));
      return mcp;
    }, 0, 'session-secret', '127.0.0.1');
    servers.push(server);
    const address = server.address() as import('net').AddressInfo;
    const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
    const clients = ['alice', 'bob'].map(name => new Client({ name, version: '1' }));
    let aliceEndpoint = '';
    try {
      await Promise.all(clients.map((client, index) => client.connect(new SSEClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${token('session-secret', index ? 'bob' : 'alice')}` } },
        fetch: async (input, init) => {
          if (!index && init?.method === 'POST') aliceEndpoint = String(input);
          return fetch(input, init);
        },
      }), { timeout: 3000 })));
      const results = await Promise.all(clients.map(client => client.callTool({ name: 'identity', arguments: {} })));
      expect(results.map(result => (result.content as any[])[0].text)).toEqual(['alice', 'bob']);
      expect(new URL(aliceEndpoint).searchParams.has('sessionId')).toBe(true);
      const hijack = await fetch(aliceEndpoint, {
        method: 'POST', headers: { authorization: `Bearer ${token('session-secret', 'bob')}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      expect(hijack.status).toBe(403);
    } finally { await Promise.all(clients.map(client => client.close())); }
  });

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

  it('forwards approval requests with the verified principal token to the shared API', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO system_state VALUES ('database_instance_id','test-db');
    `);
    const mcp = new McpServer({ name: 'test', version: '1' });
    registerOrchestrationTools(mcp, { db, mode: 'live', close: () => db.close() });
    const now = Math.floor(Date.now() / 1000);

    const bearer = token('secret');
    let received: any;
    const apiServer = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received = { path: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'approval-from-api' }));
    });
    await new Promise<void>(resolve => apiServer.listen(0, '127.0.0.1', resolve));
    servers.push(apiServer);
    const savedUrl = process.env.DJIMITFLO_API_URL;
    const savedToken = process.env.DJIMITFLO_API_TOKEN;
    const address = apiServer.address() as import('net').AddressInfo;
    process.env.DJIMITFLO_API_URL = `http://127.0.0.1:${address.port}/api`;
    process.env.DJIMITFLO_API_TOKEN = 'unrelated-privileged-token';
    try {
      const tool = (mcp as any)._registeredTools.djimitflo_approve_action;
      const result = await runWithMcpAuth({ payload: { sub: 'maker-1', email: 'a@test', role: UserRole.MAKER, iat: now, exp: now + 60 }, token: bearer },
        () => tool.handler({ task_id: 'task-1', action: 'deploy', reason: 'release', risk_level: 'high', context: {} }));
      expect(received).toEqual({ path: '/api/approvals', authorization: `Bearer ${bearer}`, body: { task_id: 'task-1', action: 'deploy', reason: 'release', risk_level: 'high', context: {} } });
      expect(JSON.parse(result.content[0].text).approval_id).toBe('approval-from-api');
    } finally {
      if (savedUrl === undefined) delete process.env.DJIMITFLO_API_URL; else process.env.DJIMITFLO_API_URL = savedUrl;
      if (savedToken === undefined) delete process.env.DJIMITFLO_API_TOKEN; else process.env.DJIMITFLO_API_TOKEN = savedToken;
      db.close();
    }
  });
});
