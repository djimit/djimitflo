/**
 * Database connection for MCP Server.
 * Uses better-sqlite3 to read from the DjimFlo SQLite database.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { join } from 'path';

export interface DbHandle {
  db: Database.Database;
  close: () => void;
}

export function createDatabase(dbPath?: string): DbHandle {
  let path = dbPath;

  if (!path) {
    const candidates = [
      process.env.DJIMITFLO_DB || '',
      join(process.cwd(), '.data', 'djimitflo.sqlite'),
      join(process.cwd(), 'djimitflo.sqlite'),
      join(process.cwd(), '..', 'server', '.data', 'djimitflo.sqlite'),
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        path = candidate;
        break;
      }
    }
  }

  if (!path) {
    throw new Error(
      'Could not find DjimFlo database. Set DJIMITFLO_DB env var or pass --db path.'
    );
  }

  if (!existsSync(path)) {
    throw new Error(`Database not found at: ${path}`);
  }

  const db = new Database(path, { readonly: true });
  db.pragma('foreign_keys = ON');

  return {
    db,
    close: () => db.close(),
  };
}
