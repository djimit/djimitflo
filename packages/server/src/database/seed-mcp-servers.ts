import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';

export function seedMCPServers(db: Database) {
  const now = new Date().toISOString();

  const servers = [
    { name: 'research-agent', url: 'http://192.168.1.28:8000', description: 'Research pipeline access — deep research, graph, history, status, steer' },
    { name: 'deerflow', url: 'http://192.168.1.28:2026', description: 'DeerFlow consulting API — research sessions, status' },
    { name: 'context7', url: 'https://context7.com/api', description: 'Library documentation — resolve library IDs, query docs' },
    { name: 'qdrant', url: 'http://192.168.1.28:6333', description: 'Semantic search — collections and vector search' },
    { name: 'searxng', url: 'http://192.168.1.28:8080', description: 'Private web search — no tracking, no API keys' },
    { name: 'litellm-mgmt', url: 'http://192.168.1.28:4000', description: 'LiteLLM management — model health, spend, status' },
    { name: 'uams-read', url: 'http://192.168.1.28:8000/memory', description: 'Agent memory search — read-only' },
    { name: 'knowledge-mcp-bridge', url: 'http://192.168.1.28:8007', description: 'Knowledge MCP bridge — domain context, recent, search' },
  ];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO mcp_servers (id, name, url, status, description, command, args, env, created_at, updated_at)
    VALUES (?, ?, ?, 'unknown', ?, '', '[]', '{}', ?, ?)
  `);

  for (const s of servers) {
    insert.run(randomUUID(), s.name, s.url, s.description, now, now);
  }
}
