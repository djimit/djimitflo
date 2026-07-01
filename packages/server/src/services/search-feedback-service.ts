import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface SearchFeedbackRecord {
  id: string;
  result_id: string;
  source: string;
  reward: number;
  capability_id: string | null;
  created_at: string;
}

export interface FeedbackStats {
  resultId: string;
  totalReward: number;
  count: number;
  averageReward: number;
}

interface FeedbackRow {
  result_id: string;
  source: string;
  reward: number;
  capability_id: string | null;
  created_at: string;
}

interface StatsRow {
  result_id: string;
  total_reward: number;
  count: number;
}

export class SearchFeedbackService {
  private maxTtlDays = 90;

  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS search_feedback (
        id TEXT PRIMARY KEY,
        result_id TEXT NOT NULL,
        source TEXT NOT NULL,
        reward REAL NOT NULL CHECK(reward >= 0 AND reward <= 1),
        capability_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_sf_result ON search_feedback(result_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_sf_source ON search_feedback(source)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_sf_created ON search_feedback(created_at)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_sf_capability ON search_feedback(capability_id)');
  }

  recordFeedback(resultId: string, source: string, reward: number, capabilityId?: string): void {
    const clampedReward = Math.max(0, Math.min(1, reward));
    this.db.prepare(`
      INSERT INTO search_feedback (id, result_id, source, reward, capability_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), resultId, source, clampedReward, capabilityId ?? null);
  }

  getFeedbackWeight(resultId: string): number {
    const row = this.db.prepare(`
      SELECT AVG(reward) as avg_reward, COUNT(*) as cnt
      FROM search_feedback WHERE result_id = ?
    `).get(resultId) as { avg_reward: number | null; cnt: number };

    if (!row.cnt || row.cnt === 0) return 0.5;

    const avg = row.avg_reward ?? 0.5;
    const confidence = Math.min(1, row.cnt / 10);
    return 0.5 + (avg - 0.5) * confidence;
  }

  getFeedbackStats(resultId: string): FeedbackStats {
    const row = this.db.prepare(`
      SELECT result_id, SUM(reward) as total_reward, COUNT(*) as count
      FROM search_feedback WHERE result_id = ? GROUP BY result_id
    `).get(resultId) as StatsRow | undefined;

    if (!row) {
      return { resultId, totalReward: 0, count: 0, averageReward: 0 };
    }

    return {
      resultId: row.result_id,
      totalReward: row.total_reward,
      count: row.count,
      averageReward: row.total_reward / row.count,
    };
  }

  getTopResults(source: string, limit: number = 10): FeedbackStats[] {
    const rows = this.db.prepare(`
      SELECT result_id, SUM(reward) as total_reward, COUNT(*) as count
      FROM search_feedback
      WHERE source = ?
      GROUP BY result_id
      ORDER BY total_reward DESC
      LIMIT ?
    `).all(source, limit) as StatsRow[];

    return rows.map(row => ({
      resultId: row.result_id,
      totalReward: row.total_reward,
      count: row.count,
      averageReward: row.total_reward / row.count,
    }));
  }

  getResultsByCapability(capabilityId: string, limit: number = 10): FeedbackStats[] {
    const rows = this.db.prepare(`
      SELECT result_id, SUM(reward) as total_reward, COUNT(*) as count
      FROM search_feedback
      WHERE capability_id = ?
      GROUP BY result_id
      ORDER BY total_reward DESC
      LIMIT ?
    `).all(capabilityId, limit) as StatsRow[];

    return rows.map(row => ({
      resultId: row.result_id,
      totalReward: row.total_reward,
      count: row.count,
      averageReward: row.total_reward / row.count,
    }));
  }

  pruneOldFeedback(maxDays: number = this.maxTtlDays): number {
    const cutoff = new Date(Date.now() - maxDays * 86400000).toISOString();
    const result = this.db.prepare('DELETE FROM search_feedback WHERE created_at < ?').run(cutoff);
    return result.changes;
  }

  getFeedbackCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as c FROM search_feedback').get() as { c: number };
    return row.c;
  }

  getRecentFeedback(limit: number = 20): SearchFeedbackRecord[] {
    const rows = this.db.prepare(`
      SELECT result_id, source, reward, capability_id, created_at
      FROM search_feedback
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as FeedbackRow[];

    return rows.map(r => ({
      id: '',
      result_id: r.result_id,
      source: r.source,
      reward: r.reward,
      capability_id: r.capability_id,
      created_at: r.created_at,
    }));
  }
}
