import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import { createMCPRoutes } from '../routes/mcp';
import { installOutboundGuard } from '../utils/outbound-guard';

describe('MCP routes', () => {
  let db: Database.Database;
  let server: ReturnType<ReturnType<typeof express>['listen']>;
  let baseUrl: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        command TEXT NOT NULL,
        args TEXT NOT NULL,
        env TEXT NOT NULL,
        version TEXT,
        author TEXT,
        url TEXT,
        last_ping_at TEXT,
        error_message TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE mcp_tools (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        permission TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        input_schema TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE mcp_tool_permissions (
        id TEXT PRIMARY KEY,
        tool_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        reason TEXT,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO mcp_servers VALUES ('s1', 'deerflow', '', 'running', '', '[]', '{}', null, null, null, '2000-01-01T00:00:00.000Z', null, '{}', 'now', 'now')").run();
    db.prepare("INSERT INTO mcp_servers VALUES ('s2', 'knowledge', '', 'running', '', '[]', '{}', null, null, null, '2000-01-01T00:00:00.000Z', null, '{}', 'now', 'now')").run();
    db.prepare("INSERT INTO mcp_tools VALUES ('t1', 's1', 'post_job', '', 'requires_approval', 'medium', '{}', '{}', 'now', 'now')").run();
    db.prepare("INSERT INTO mcp_tools VALUES ('t2', 's2', 'get_search', '', 'allowed', 'low', '{}', '{}', 'now', 'now')").run();
    db.prepare("INSERT INTO mcp_tool_permissions VALUES ('p1', 't1', 'requires_approval', 'medium', 'mutates', '{}', 'now', 'now')").run();
    db.prepare("INSERT INTO mcp_tool_permissions VALUES ('p2', 't2', 'allowed', 'low', 'reads', '{}', 'now', 'now')").run();

    const app = express();
    app.use(express.json());
    app.use(createMCPRoutes(db, {
      requireAuth: (req: any, _res: any, next: any) => { req.user = { role: 'admin' }; next(); },
      requirePermission: () => (_req: any, _res: any, next: any) => next(),
    } as any));
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  });

  it('filters permissions by server, decision, and risk level', async () => {
    const response = await fetch(`${baseUrl}/permissions?server_id=s1&server_id=s2&decision=requires_approval&risk_level=medium&q=job`);
    const body = await response.json() as { permissions: Array<Record<string, unknown>> };

    expect(body.permissions).toHaveLength(1);
    expect(body.permissions[0]).toMatchObject({
      tool_name: 'post_job',
      server_name: 'deerflow',
      decision: 'requires_approval',
      risk_level: 'medium',
    });
  });

  it('reports stale running servers without rewriting persisted history', async () => {
    const response = await fetch(`${baseUrl}/servers`);
    const body = await response.json() as { servers: Array<Record<string, unknown>> };
    expect(body.servers[0]).toMatchObject({
      status: 'running',
      effective_status: 'stale',
      status_stale: true,
      tool_count: 1,
      approval_gate_count: 1,
    });
    expect((db.prepare("SELECT status FROM mcp_servers WHERE id = 's1'").get() as { status: string }).status).toBe('running');
  });

  it('reports the local runtime row as a synced catalog, not a stale network service', async () => {
    db.prepare("UPDATE mcp_servers SET id = 'djimitflo-runtime' WHERE id = 's1'").run();

    const body = await (await fetch(`${baseUrl}/servers`)).json() as { servers: Array<Record<string, unknown>> };
    expect(body.servers[0]).toMatchObject({ effective_status: 'catalog', status_stale: false });
  });

  it('registers a new MCP server via POST /servers', async () => {
    const response = await fetch(`${baseUrl}/servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'my-tool-server', description: 'A new tool server', url: 'http://example.com' }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { server: Record<string, unknown> };
    expect(body.server).toMatchObject({ name: 'my-tool-server', description: 'A new tool server', url: 'http://example.com', status: 'unknown' });
    const row = db.prepare("SELECT * FROM mcp_servers WHERE name = 'my-tool-server'").get();
    expect(row).toBeTruthy();
  });

  it('rejects POST /servers with a missing name or description', async () => {
    const missingName = await fetch(`${baseUrl}/servers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'no name' }),
    });
    expect(missingName.status).toBe(400);
    const missingDescription = await fetch(`${baseUrl}/servers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'no-description' }),
    });
    expect(missingDescription.status).toBe(400);
  });

  it('rejects POST /servers with a duplicate name', async () => {
    const response = await fetch(`${baseUrl}/servers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'deerflow', description: 'duplicate' }),
    });
    expect(response.status).toBe(409);
  });

  it('skips the health probe and reports a calm status for a known_unreachable server', async () => {
    db.prepare("INSERT INTO mcp_servers VALUES ('s3', 'offline-tool', '', 'unknown', '', '[]', '{}', null, null, 'http://192.168.1.28:9', null, null, ?, 'now', 'now')")
      .run(JSON.stringify({ known_unreachable: true, known_unreachable_reason: 'Firewalled from this deployment.' }));
    const response = await fetch(`${baseUrl}/servers?refresh=true`);
    const body = await response.json() as { servers: Array<Record<string, unknown>> };
    const offline = body.servers.find((s) => s.name === 'offline-tool');
    expect(offline).toMatchObject({ status: 'stopped', error_message: 'Firewalled from this deployment.' });
  });

  it('reports a host refused by the outbound guard as stopped by policy, not as an error', async () => {
    const original = globalThis.fetch;
    installOutboundGuard({ OUTBOUND_DENY_HOSTS: 'blocked.invalid' }, () => undefined);
    try {
      db.prepare("INSERT INTO mcp_servers VALUES ('s4', 'workstation-tool', '', 'unknown', '', '[]', '{}', null, null, 'http://blocked.invalid:9', null, null, '{}', 'now', 'now')").run();
      const body = await (await fetch(`${baseUrl}/servers?refresh=true`)).json() as { servers: Array<Record<string, unknown>> };
      const ws = body.servers.find((s) => s.name === 'workstation-tool');
      expect(ws?.status).toBe('stopped');
      expect(String(ws?.error_message)).toContain('Blocked by policy');
    } finally { globalThis.fetch = original; }
  });

  it('reports policy-isolated servers separately from stopped services', async () => {
    db.prepare("UPDATE mcp_servers SET status = 'stopped', metadata = ? WHERE id = 's1'")
      .run(JSON.stringify({ known_unreachable: true }));

    const response = await fetch(`${baseUrl}/servers`);
    const body = await response.json() as { servers: Array<Record<string, unknown>> };
    expect(body.servers[0]).toMatchObject({ status: 'stopped', effective_status: 'policy_blocked' });
  });

  it('preserves policy-isolated status for manually registered servers', async () => {
    db.prepare("UPDATE mcp_servers SET status = 'stopped', error_message = ? WHERE id = 's1'")
      .run('Blocked by policy: host is in OUTBOUND_DENY_HOSTS.');

    const body = await (await fetch(`${baseUrl}/servers`)).json() as { servers: Array<Record<string, unknown>> };
    expect(body.servers[0]).toMatchObject({ status: 'stopped', effective_status: 'policy_blocked' });
  });
});
