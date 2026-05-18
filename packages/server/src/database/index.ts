/**
 * Database initialization and connection
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { schema } from './schema';
import { runMigrations } from './migrate';

// Get the monorepo root (3 levels up from packages/server/src)
const MONOREPO_ROOT = process.cwd().includes('/packages/server')
  ? join(process.cwd(), '../..')
  : process.cwd();

const DATA_DIR = join(MONOREPO_ROOT, '.data');
const DB_PATH = process.env.DB_PATH || join(DATA_DIR, 'djimitflo.sqlite');

// Ensure .data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

export function initializeDatabase(): Database.Database {
  console.log(`📦 Opening database at ${DB_PATH}`);
  
  const db = new Database(DB_PATH, {
    verbose: process.env.NODE_ENV === 'development' ? console.log : undefined,
  });
  
  // Enable foreign keys
  db.pragma('foreign_keys = ON');
  
  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');
  
  // Run schema
  console.log('📋 Applying database schema...');
  db.exec(schema);
  runMigrations(db);
  
  console.log('✅ Database initialized');
  
  return db;
}

export { Database };
