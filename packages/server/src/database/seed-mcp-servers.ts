import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';

function parseMetadata(value: unknown): Record<string, unknown> {
  try {
    return JSON.parse(String(value || '{}')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function seedMCPServers(db: Database) {
  const now = new Date().toISOString();

  const servers = [
    { name: 'research-agent', url: 'http://192.168.1.28:8000', description: 'Research pipeline access — deep research, graph, history, status, steer', metadata: { probe_path: '/health' } },
    { name: 'deerflow', url: 'http://192.168.1.28:2026', description: 'DeerFlow consulting API — research sessions, status', metadata: { probe_path: '/health', openapi_path: '/openapi.json' } },
    { name: 'context7', url: 'https://context7.com', description: 'Library documentation — resolve library IDs, query docs', metadata: { api_url: 'https://context7.com/api' } },
    { name: 'qdrant', url: 'http://192.168.1.28:6333', description: 'Semantic search — collections and vector search', metadata: { probe_path: '/healthz' } },
    { name: 'searxng', url: 'http://192.168.1.28:8080', description: 'Private web search — no tracking, no API keys' },
    { name: 'litellm-mgmt', url: 'http://192.168.1.28:4000', description: 'LiteLLM management — model health, spend, status', metadata: { probe_path: '/health/readiness' } },
    { name: 'uams-read', url: 'http://192.168.1.28:8000/memory', description: 'Agent memory search — read-only', metadata: { probe_url: 'http://192.168.1.28:8000/health' } },
    { name: 'knowledge-mcp-bridge', url: 'http://192.168.1.28:8007', description: 'Knowledge MCP bridge — domain context, recent, search', metadata: { probe_path: '/openapi.json', openapi_path: '/openapi.json' } },
  ];

  const upsert = db.prepare(`
    INSERT INTO mcp_servers (id, name, url, status, description, command, args, env, metadata, created_at, updated_at)
    VALUES (?, ?, ?, 'unknown', ?, '', '[]', '{}', ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      url = excluded.url,
      description = excluded.description,
      metadata = excluded.metadata,
      updated_at = excluded.updated_at
  `);
  const existing = db.prepare('SELECT metadata FROM mcp_servers WHERE name = ?');

  for (const s of servers) {
    const row = existing.get(s.name) as { metadata?: string } | undefined;
    const mergedMetadata = { ...parseMetadata(row?.metadata), ...(s.metadata || {}) };
    upsert.run(randomUUID(), s.name, s.url, s.description, JSON.stringify(mergedMetadata), now, now);
  }
}
