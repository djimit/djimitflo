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

  // Operator rule 2026-09-29: the control plane never calls the workstation (it only pulls; OUTBOUND_DENY_HOSTS enforces it).
  // Sidecars that also run on agenticservices (100.77.58.72) point there — Knowledge MCP 2.0-hybrid and UAMS verified
  // identical, Qdrant there holds a superset of every collection. Workstation-only sidecars are marked known_unreachable
  // with the reason, so the page shows 'stopped' instead of repainting a refusal as an error. (Metadata is merged with the
  // stored row, so the marker is set/cleared explicitly.)
  const AGENTIC = 'http://100.77.58.72';
  const reachable = { known_unreachable: false, known_unreachable_reason: null };
  const dependency = { catalog_only: true, integration_kind: 'dependency' };
  const workstationOnly = { known_unreachable: true, known_unreachable_reason: 'Workstation-local service: the control plane never calls the workstation (operator rule 2026-09-29). Use it from the workstation\'s own agents, or run it on agenticservices.' };
  const servers = [
    { name: 'research-agent', url: `${AGENTIC}:8000`, description: 'Research pipeline access — deep research, graph, history, status, steer', metadata: { probe_path: '/health', ...dependency, ...reachable } },
    { name: 'deerflow', url: 'http://100.81.133.48:2026', description: 'DeerFlow consulting API — research sessions, status', metadata: { probe_path: '/health', openapi_path: '/openapi.json', ...workstationOnly } },
    { name: 'context7', url: 'https://context7.com', description: 'Library documentation — resolve library IDs, query docs', metadata: { api_url: 'https://context7.com/api', ...dependency } },
    { name: 'qdrant', url: `${AGENTIC}:6333`, description: 'Semantic search — collections and vector search', metadata: { probe_path: '/healthz', ...dependency, ...reachable } },
    { name: 'searxng', url: 'http://100.81.133.48:8080', description: 'Private web search — no tracking, no API keys', metadata: { ...dependency, ...workstationOnly } },
    { name: 'litellm-mgmt', url: 'http://100.81.133.48:4000', description: 'LiteLLM management — model health, spend, status', metadata: { probe_path: '/health/readiness', ...dependency, ...workstationOnly } },
    { name: 'uams-read', url: `${AGENTIC}:8000/memory`, description: 'Agent memory search — read-only', metadata: { probe_url: `${AGENTIC}:8000/health`, ...dependency, ...reachable } },
    { name: 'knowledge-mcp-bridge', url: `${AGENTIC}:8007`, description: 'Knowledge MCP bridge — domain context, recent, search', metadata: { probe_path: '/openapi.json', openapi_path: '/openapi.json', ...reachable } },
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
