/**
 * Database connection for MCP Server.
 * Uses better-sqlite3 to access the DjimFlo SQLite database.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'fs';
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
