import type { Database } from 'better-sqlite3';

/**
 * Server-side OpenAPI → tool catalog sync for HTTP sidecars. Prod 2026-09-24: 5 "running" servers showed "Visible tools: 0"
 * because the only sync was the mcp-server's manual `djimitflo_sync_http_sidecar_catalog` tool, run once for one server.
 * Same classification as that tool: GET/HEAD/OPTIONS allowed (low), everything else requires approval (medium).
 * ponytail: mirrors packages/mcp-server/src/tools/governance.ts; share it if a third caller appears.
 */
export const MAX_OPERATIONS = 100; // litellm exposes 528 admin endpoints (incl. key management): never mirror those in bulk

const slug = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

export function openApiUrl(url: string | null, meta: Record<string, unknown>): string {
  if (meta.openapi_url) return String(meta.openapi_url);
  if (meta.openapi_path && url) return new URL(String(meta.openapi_path), url).toString();
  return '';
}

/** Syncs one server's operations; returns the number synced, or an error string. Never throws. */
export async function syncOpenApiCatalog(db: Database, server: { id: string; url: string | null; metadata: Record<string, unknown> }, fetchImpl: typeof fetch = fetch): Promise<number | string> {
  const url = openApiUrl(server.url, server.metadata);
  if (!url) return 'no openapi_path';
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return `HTTP ${res.status}`;
    const spec = await res.json() as { paths?: Record<string, Record<string, { summary?: string; operationId?: string; parameters?: unknown[]; requestBody?: unknown }>> };
    const ops = Object.entries(spec.paths || {}).flatMap(([path, methods]) => Object.entries(methods || {})
      .filter(([m]) => /^(get|post|put|patch|delete|head|options)$/i.test(m)).map(([m, op]) => ({ path, method: m.toUpperCase(), op })));
    if (ops.length > MAX_OPERATIONS) return `${ops.length} operations > ${MAX_OPERATIONS}; curate instead of mirroring`;
    const upsertTool = db.prepare(`INSERT INTO mcp_tools (id, server_id, name, description, permission, risk_level, input_schema, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(id) DO UPDATE SET description = excluded.description, permission = excluded.permission, risk_level = excluded.risk_level,
        input_schema = excluded.input_schema, metadata = excluded.metadata, updated_at = datetime('now')`);
    const upsertPermission = db.prepare(`INSERT INTO mcp_tool_permissions (id, tool_id, decision, risk_level, reason, last_seen_at, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'), ?, datetime('now'), datetime('now'))
      ON CONFLICT(tool_id) DO UPDATE SET decision = excluded.decision, risk_level = excluded.risk_level, reason = excluded.reason,
        last_seen_at = excluded.last_seen_at, metadata = excluded.metadata, updated_at = datetime('now')`);
    db.transaction(() => {
      for (const { path, method, op } of ops) {
        const name = slug(`${method}_${path}`); const id = `${server.id}:${name}`;
        const [decision, risk] = /^(GET|HEAD|OPTIONS)$/.test(method) ? ['allowed', 'low'] : ['requires_approval', 'medium'];
        upsertTool.run(id, server.id, name, `${method} ${path}${op.summary ? ` - ${op.summary}` : ''}`, decision, risk,
          JSON.stringify({ method, path, parameters: op.parameters || [], has_request_body: Boolean(op.requestBody) }),
          JSON.stringify({ synced_from: 'server_openapi_sync', openapi_url: url, operation_id: op.operationId || null }));
        upsertPermission.run(`${id}:permission`, id, decision, risk, `synced ${decision}/${risk} from OpenAPI operation ${name}`, JSON.stringify({ synced_from: 'server_openapi_sync' }));
      }
    })();
    return ops.length;
  } catch (error) {
    return error instanceof Error ? error.message : 'OpenAPI sync failed';
  }
}
