import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { seedMCPServers } from '../database/seed-mcp-servers';

describe('seedMCPServers', () => {
  it('updates canonical probe metadata without resetting runtime status', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
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
      )
    `);
    db.prepare(`
      INSERT INTO mcp_servers (id, name, description, status, command, args, env, url, error_message, metadata, created_at, updated_at)
      VALUES ('context7-id', 'context7', 'old', 'error', '', '[]', '{}', 'https://context7.com/api', 'old error', '{}', 'old', 'old')
    `).run();
    db.prepare(`
      INSERT INTO mcp_servers (id, name, description, status, command, args, env, url, error_message, metadata, created_at, updated_at)
      VALUES ('deerflow-id', 'deerflow', 'old', 'stopped', '', '[]', '{}', 'http://old.test', 'offline', '{"owner":"ops","probe_path":"/old"}', 'old', 'old')
    `).run();

    seedMCPServers(db);

    const row = db.prepare('SELECT * FROM mcp_servers WHERE name = ?').get('context7') as {
      id: string;
      status: string;
      url: string;
      error_message: string;
      metadata: string;
    };
    expect(row.id).toBe('context7-id');
    expect(row.status).toBe('error');
    expect(row.error_message).toBe('old error');
    expect(row.url).toBe('https://context7.com');
    expect(JSON.parse(row.metadata)).toEqual({ api_url: 'https://context7.com/api' });
    const deerflow = db.prepare('SELECT status, error_message, metadata FROM mcp_servers WHERE name = ?').get('deerflow') as { status: string; error_message: string; metadata: string };
    const knowledge = db.prepare('SELECT metadata FROM mcp_servers WHERE name = ?').get('knowledge-mcp-bridge') as { metadata: string };
    expect(deerflow.status).toBe('stopped');
    expect(deerflow.error_message).toBe('offline');
    expect(JSON.parse(deerflow.metadata)).toMatchObject({ probe_path: '/health', openapi_path: '/openapi.json' });
    expect(JSON.parse(deerflow.metadata)).toMatchObject({ owner: 'ops' });
    expect(JSON.parse(knowledge.metadata)).toMatchObject({ probe_path: '/openapi.json', openapi_path: '/openapi.json' });
    expect((db.prepare('SELECT COUNT(*) AS c FROM mcp_servers').get() as { c: number }).c).toBe(8);

    db.close();
  });
});
