/**
 * Database connection for MCP Server.
 * Uses better-sqlite3 to access the DjimFlo SQLite database.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';

export interface DbHandle {
  db: Database.Database;
  close: () => void;
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
    close: () => db.close(),
  };
}
