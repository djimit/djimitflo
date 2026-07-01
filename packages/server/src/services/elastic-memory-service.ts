import type { Database } from 'better-sqlite3';

export type MemoryTier = 'hot' | 'warm' | 'cold';

export interface CollectionStats {
  name: string;
  queryRate: number;
  lastAccess: string;
  tier: MemoryTier;
  size: number;
}

interface MemoryStatsRow {
  collection_name: string;
  query_count: number;
  last_access: string;
  tier: string;
}

export class ElasticMemoryService {
  private hotThreshold = 10;
  private warmThreshold = 2;
  private coldDays = 30;

  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_tier_stats (
        collection_name TEXT PRIMARY KEY,
        query_count INTEGER DEFAULT 0,
        last_access TEXT,
        tier TEXT DEFAULT 'warm'
      )
    `);
  }

  measureCognitiveLoad(): number {
    const rows = this.db.prepare('SELECT query_count FROM memory_tier_stats').all() as Array<{ query_count: number }>;
    const total = rows.reduce((sum, r) => sum + r.query_count, 0);
    return Math.min(1, total / 100);
  }

  adjustAllocation(): void {
    const rows = this.db.prepare('SELECT * FROM memory_tier_stats').all() as MemoryStatsRow[];

    for (const row of rows) {
      let newTier: MemoryTier;
      if (row.query_count >= this.hotThreshold) {
        newTier = 'hot';
      } else if (row.query_count >= this.warmThreshold) {
        newTier = 'warm';
      } else {
        newTier = 'cold';
      }

      if (newTier !== row.tier) {
        this.db.prepare('UPDATE memory_tier_stats SET tier = ? WHERE collection_name = ?').run(newTier, row.collection_name);
      }
    }
  }

  compressColdData(days: number = this.coldDays): number {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const rows = this.db.prepare(
      "SELECT collection_name FROM memory_tier_stats WHERE last_access < ? AND tier = 'cold'"
    ).all(cutoff) as Array<{ collection_name: string }>;

    for (const row of rows) {
      this.db.prepare("UPDATE memory_tier_stats SET tier = 'cold' WHERE collection_name = ?").run(row.collection_name);
    }

    return rows.length;
  }

  getCollectionStats(collectionName: string): CollectionStats | null {
    const row = this.db.prepare('SELECT * FROM memory_tier_stats WHERE collection_name = ?').get(collectionName) as MemoryStatsRow | undefined;
    if (!row) return null;
    return {
      name: row.collection_name,
      queryRate: row.query_count,
      lastAccess: row.last_access ?? new Date().toISOString(),
      tier: row.tier as MemoryTier,
      size: 0,
    };
  }

  recordQuery(collectionName: string): void {
    const existing = this.db.prepare('SELECT query_count FROM memory_tier_stats WHERE collection_name = ?').get(collectionName) as { query_count: number } | undefined;
    if (existing) {
      this.db.prepare("UPDATE memory_tier_stats SET query_count = query_count + 1, last_access = datetime('now') WHERE collection_name = ?").run(collectionName);
    } else {
      this.db.prepare("INSERT INTO memory_tier_stats (collection_name, query_count, last_access, tier) VALUES (?, 1, datetime('now'), 'warm')").run(collectionName);
    }
  }

  setTier(collectionName: string, tier: MemoryTier): void {
    this.db.prepare('UPDATE memory_tier_stats SET tier = ? WHERE collection_name = ?').run(tier, collectionName);
  }

  getAllTiers(): CollectionStats[] {
    const rows = this.db.prepare('SELECT * FROM memory_tier_stats ORDER BY query_count DESC').all() as MemoryStatsRow[];
    return rows.map(r => ({
      name: r.collection_name,
      queryRate: r.query_count,
      lastAccess: r.last_access ?? new Date().toISOString(),
      tier: r.tier as MemoryTier,
      size: 0,
    }));
  }
}
