import { randomUUID } from 'crypto';
import { hostname } from 'os';
import type { Database } from 'better-sqlite3';
import { resolveDbPath } from './path';

const INSTANCE_KEY = 'database_instance_id';

export function ensureDatabaseInstanceId(db: Database): string {
  const existing = db.prepare('SELECT value FROM system_state WHERE key = ?').get(INSTANCE_KEY) as { value?: string } | undefined;
  if (existing?.value) return existing.value;

  const id = randomUUID();
  db.prepare('INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))').run(INSTANCE_KEY, id);
  return id;
}

export function getDatabaseProvenance(db: Database) {
  const instance = db.prepare('SELECT value FROM system_state WHERE key = ?').get(INSTANCE_KEY) as { value?: string } | undefined;
  return {
    instance_id: instance?.value ?? null,
    node_id: process.env.DJIMITFLO_NODE_ID || hostname(),
    path: resolveDbPath(),
    mode: process.env.DJIMITFLO_DATA_MODE || 'live',
    commit_sha: process.env.DJIMITFLO_COMMIT_SHA || null,
  };
}
