import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { MAX_OPERATIONS, openApiUrl, syncOpenApiCatalog } from '../services/mcp-openapi-catalog';

let db: Database.Database;
const spec = (paths: Record<string, unknown>) => vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ paths }) }) as unknown as typeof fetch;
const server = { id: 'df', url: 'http://100.81.133.48:2026', metadata: { openapi_path: '/openapi.json' } };
beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  db.prepare(`INSERT INTO mcp_servers (id, name, description, status, command, args, env, url, metadata, created_at, updated_at) VALUES ('df', 'test-sidecar', 'd', 'running', '', '[]', '{}', ?, '{}', 'now', 'now')`).run(server.url);
});
afterEach(() => db.close());

it('resolves the spec URL from openapi_url or openapi_path', () => {
  expect(openApiUrl('http://h:1', { openapi_path: '/openapi.json' })).toBe('http://h:1/openapi.json');
  expect(openApiUrl('http://h:1', { openapi_url: 'http://x/spec' })).toBe('http://x/spec');
  expect(openApiUrl('http://h:1', {})).toBe('');
});

it('imports operations: reads are allowed, writes need approval; idempotent', async () => {
  const f = spec({ '/api/threads': { get: { summary: 'List threads' }, post: { summary: 'Create' } }, '/health': { get: {} } });
  expect(await syncOpenApiCatalog(db, server, f)).toBe(3);
  expect(await syncOpenApiCatalog(db, server, f)).toBe(3);
  const rows = db.prepare(`SELECT t.name, p.decision, p.risk_level FROM mcp_tools t JOIN mcp_tool_permissions p ON p.tool_id = t.id WHERE t.server_id = 'df' ORDER BY t.name`).all();
  expect(rows).toEqual([
    { name: 'get_api_threads', decision: 'allowed', risk_level: 'low' },
    { name: 'get_health', decision: 'allowed', risk_level: 'low' },
    { name: 'post_api_threads', decision: 'requires_approval', risk_level: 'medium' },
  ]);
});

it('refuses to mirror a huge admin API in bulk (litellm: 528 operations) and never throws', async () => {
  const many = Object.fromEntries(Array.from({ length: MAX_OPERATIONS + 1 }, (_, i) => [`/p${i}`, { get: {} }]));
  expect(await syncOpenApiCatalog(db, server, spec(many))).toBe(`${MAX_OPERATIONS + 1} operations > ${MAX_OPERATIONS}; curate instead of mirroring`);
  expect(await syncOpenApiCatalog(db, server, vi.fn().mockResolvedValue({ ok: false, status: 401 }) as unknown as typeof fetch)).toBe('HTTP 401');
  expect(await syncOpenApiCatalog(db, server, vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch)).toBe('ECONNREFUSED');
  expect(db.prepare('SELECT COUNT(*) AS n FROM mcp_tools').get()).toEqual({ n: 0 });
});
