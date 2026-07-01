import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { AdapterCacheEntry } from './types';

export class AdapterCache {
  private ttlMs = 3600_000; // 1 hour

  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_adapter_cache (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        query_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_kac_hash ON knowledge_adapter_cache(query_hash)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_kac_expires ON knowledge_adapter_cache(expires_at)');
  }

  get(source: string, query: string): unknown[] | null {
    const hash = this.hashQuery(query);
    const entry = this.db.prepare(
      'SELECT result_json, expires_at FROM knowledge_adapter_cache WHERE source = ? AND query_hash = ?'
    ).get(source, hash) as AdapterCacheEntry | undefined;

    if (!entry) return null;

    const expires = new Date(entry.expires_at).getTime();
    if (Date.now() > expires) {
      this.db.prepare('DELETE FROM knowledge_adapter_cache WHERE source = ? AND query_hash = ?').run(source, hash);
      return null;
    }

    try {
      return JSON.parse(entry.result_json) as unknown[];
    } catch {
      return null;
    }
  }

  set(source: string, query: string, results: unknown[]): void {
    const hash = this.hashQuery(query);
    const id = createHash('sha256').update(`${source}-${hash}`).digest('hex').slice(0, 16);
    const expires = new Date(Date.now() + this.ttlMs).toISOString();

    this.db.prepare(`
      INSERT OR REPLACE INTO knowledge_adapter_cache (id, source, query_hash, result_json, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, source, hash, JSON.stringify(results), expires);
  }

  cleanup(): number {
    const result = this.db.prepare("DELETE FROM knowledge_adapter_cache WHERE expires_at < datetime('now')").run();
    return result.changes;
  }

  private hashQuery(query: string): string {
    return createHash('sha256').update(query.toLowerCase().trim()).digest('hex').slice(0, 16);
  }
}
