import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import { createMCPRoutes } from '../routes/mcp';

describe('MCP routes', () => {
  let db: Database.Database;
  let server: ReturnType<ReturnType<typeof express>['listen']>;
  let baseUrl: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        command TEXT NOT NULL,
        args TEXT NOT NULL,
        env TEXT NOT NULL,
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
    db.prepare("INSERT INTO mcp_servers VALUES ('s1', 'deerflow', '', 'running', '', '[]', '{}', null, '2000-01-01T00:00:00.000Z', null, '{}', 'now', 'now')").run();
    db.prepare("INSERT INTO mcp_servers VALUES ('s2', 'knowledge', '', 'running', '', '[]', '{}', null, '2000-01-01T00:00:00.000Z', null, '{}', 'now', 'now')").run();
    db.prepare("INSERT INTO mcp_tools VALUES ('t1', 's1', 'post_job', '', 'requires_approval', 'medium', '{}', '{}', 'now', 'now')").run();
    db.prepare("INSERT INTO mcp_tools VALUES ('t2', 's2', 'get_search', '', 'allowed', 'low', '{}', '{}', 'now', 'now')").run();
    db.prepare("INSERT INTO mcp_tool_permissions VALUES ('p1', 't1', 'requires_approval', 'medium', 'mutates', '{}', 'now', 'now')").run();
    db.prepare("INSERT INTO mcp_tool_permissions VALUES ('p2', 't2', 'allowed', 'low', 'reads', '{}', 'now', 'now')").run();

    const app = express();
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
    expect(body.servers[0]).toMatchObject({ status: 'running', effective_status: 'stale', status_stale: true });
    expect((db.prepare("SELECT status FROM mcp_servers WHERE id = 's1'").get() as { status: string }).status).toBe('running');
  });
});
