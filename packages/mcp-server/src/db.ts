/**
 * Database connection for MCP Server.
 * Uses better-sqlite3 to access the DjimFlo SQLite database.
 */

import Database from 'better-sqlite3';
import { existsSync, statSync } from 'fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isAbsolute, join, resolve } from 'path';
import { hostname } from 'os';

export interface DbHandle {
  db: Database.Database;
  path?: string;
  mode?: 'snapshot' | 'live';
  close: () => void;
}

export function requireLiveMode(handle: DbHandle): void {
  if (handle.mode !== 'live') {
    throw new Error('DJIMITFLO_LIVE_DATA_REQUIRED');
  }
  const provenance = databaseProvenance(handle);
  if (!provenance.instance_id) throw new Error('DJIMITFLO_DATABASE_ID_REQUIRED');
  const expected = process.env.DJIMITFLO_EXPECTED_INSTANCE_ID;
  if (expected && provenance.instance_id !== expected) {
    throw new Error(`DJIMITFLO_DATABASE_ID_MISMATCH:${provenance.instance_id}`);
  }
}

function stateValue(handle: DbHandle, key: string): string | null {
  try {
    const row = handle.db.prepare('SELECT value FROM system_state WHERE key = ?').get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export function databaseProvenance(handle: DbHandle) {
  return {
    instance_id: stateValue(handle, 'database_instance_id'),
    node_id: process.env.DJIMITFLO_NODE_ID || hostname(),
    path: handle.path || handle.db.name || ':memory:',
    mode: handle.mode || 'snapshot',
    commit_sha: process.env.DJIMITFLO_COMMIT_SHA || null,
  };
}

export function monorepoRoot(cwd = process.cwd()): string {
  return cwd.includes('/packages/') ? resolve(cwd.split('/packages/')[0]) : cwd;
}

function configuredPath(path: string, env = process.env, cwd = process.cwd()): string {
  return isAbsolute(path) ? path : resolve(env.INIT_CWD || cwd, path);
}

export function resolveDatabasePath(dbPath?: string, env = process.env, cwd = process.cwd()): string | undefined {
  const configured = dbPath || env.DJIMITFLO_DB || env.DB_PATH;
  if (configured) return configuredPath(configured, env, cwd);

  const root = monorepoRoot(cwd);
  return [
    join(root, '.data', 'djimitflo.sqlite'),
    join(cwd, '.data', 'djimitflo.sqlite'),
    join(cwd, 'djimitflo.sqlite'),
  ].find((candidate) => existsSync(candidate));
}

export function createDatabase(dbPath?: string): DbHandle {
  const path = resolveDatabasePath(dbPath);

  if (!path) {
    throw new Error(
      'Could not find DjimFlo database. Set DJIMITFLO_DB, DB_PATH, or pass --db path.'
    );
  }

  if (!existsSync(path)) {
    throw new Error(`Database not found at: ${path}`);
  }

  const db = new Database(path);
  db.pragma('foreign_keys = ON');

  return {
    db,
    path,
    mode: process.env.DJIMITFLO_DATA_MODE === 'live' ? 'live' : 'snapshot',
    close: () => db.close(),
  };
}

/** The production database path inside the djimitflo container; any other path is a copy or a snapshot. */
export const PROD_DB_PATH = '/data/djimitflo.sqlite';

/**
 * O2c (re-20261029: agents read a July snapshot through this server as prod): how fresh the data is and whether it is the
 * production database. data_as_of = newest loop_runs.created_at, else the DB file's mtime, else null (unknown — never now).
 */
export function dataLabel(handle: DbHandle): { data_as_of: string | null; is_production: boolean; db_path: string } {
  const path = handle.path || handle.db.name || ':memory:';
  let asOf: string | null = null;
  try { asOf = (handle.db.prepare('SELECT MAX(created_at) AS t FROM loop_runs').get() as { t: string | null } | undefined)?.t ?? null; } catch { /* no loop_runs */ }
  if (!asOf) { try { asOf = existsSync(path) ? statSync(path).mtime.toISOString() : null; } catch { asOf = null; } }
  return { data_as_of: asOf, is_production: path === PROD_DB_PATH, db_path: path };
}

/** Served by the live API, not by this DB: their answers are not a snapshot and carry no data label. */
const API_ONLY_TOOLS = new Set(['djimitflo_council_ask', 'djimitflo_generate_export']);

/**
 * The server as seen by a DB-backed tool registrar: every tool it registers answers with one extra text block holding
 * dataLabel(handle) (content[0] and structured content are unchanged). The wrapped handler is marked for the tests.
 */
export function labelDbTools(server: McpServer, handle: DbHandle): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== 'registerTool') return Reflect.get(target, prop, receiver);
      return (name: string, config: unknown, cb: (...args: unknown[]) => unknown) => {
        if (API_ONLY_TOOLS.has(name) || typeof cb !== 'function') return (target.registerTool as (...a: unknown[]) => unknown)(name, config, cb);
        const labelled = Object.assign(async (...args: unknown[]) => {
          const result = await cb(...args) as { content?: Array<{ type: string; text?: string }> } | undefined;
          if (!result || !Array.isArray(result.content)) return result;
          return { ...result, content: [...result.content, { type: 'text' as const, text: JSON.stringify(dataLabel(handle)) }] };
        }, { djimitfloDataLabel: true });
        return (target.registerTool as (...a: unknown[]) => unknown)(name, config, labelled);
      };
    },
  });
}
