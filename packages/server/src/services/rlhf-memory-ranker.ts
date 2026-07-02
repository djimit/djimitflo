import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { MemoryRecord } from './memory-store';

export interface RankedMemory {
  record: MemoryRecord;
  reward: number;
  rank: number;
  advantage: number;
}

export interface RewardSignal {
  memoryId: string;
  loopRunId: string;
  outcome: 'success' | 'failure' | 'partial';
  utilityScore: number;
  timestamp: string;
}

export interface PolicyUpdate {
  memoryId: string;
  oldReward: number;
  newReward: number;
  advantage: number;
  clipped: boolean;
}

export class RLHFMemoryRanker {
  private clipEpsilon: number;
  private baselineWindow: number;

  constructor(
    private db: Database,
    options: { clipEpsilon?: number; baselineWindow?: number } = {},
  ) {
    this.clipEpsilon = options.clipEpsilon ?? 0.2;
    this.baselineWindow = options.baselineWindow ?? 20;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_rewards (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        loop_run_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        utility_score REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_policy (
        memory_id TEXT PRIMARY KEY,
        reward REAL NOT NULL DEFAULT 0.5,
        advantage REAL NOT NULL DEFAULT 0,
        update_count INTEGER NOT NULL DEFAULT 0,
        last_updated TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  recordReward(signal: RewardSignal): void {
    this.db.prepare(`
      INSERT INTO memory_rewards (id, memory_id, loop_run_id, outcome, utility_score)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), signal.memoryId, signal.loopRunId, signal.outcome, signal.utilityScore);

    this.updatePolicy(signal.memoryId);
  }

  rankMemories(memories: MemoryRecord[]): RankedMemory[] {
    const baseline = this.getBaselineReward();

    const ranked = memories.map((record, index) => {
      const policy = this.getPolicy(record.id);
      const reward = policy?.reward ?? 0.5;
      const advantage = reward - baseline;

      return {
        record,
        reward,
        rank: index + 1,
        advantage,
      };
    });

    ranked.sort((a, b) => b.reward - a.reward);
    ranked.forEach((r, i) => { r.rank = i + 1; });

    return ranked;
  }

  getTopMemories(limit: number = 10): RankedMemory[] {
    const memories = this.db.prepare(`
      SELECT id, type, content, source, confidence, metadata_json, created_at
      FROM central_memories ORDER BY confidence DESC LIMIT ?
    `).all(limit) as Array<{
      id: string; type: string; content: string; source: string;
      confidence: number; metadata_json: string; created_at: string;
    }>;

    const records: MemoryRecord[] = memories.map(m => ({
      id: m.id, type: m.type as MemoryRecord['type'], content: m.content,
      source: m.source, confidence: m.confidence,
      metadata: JSON.parse(m.metadata_json) as Record<string, unknown>,
      createdAt: m.created_at,
    }));

    return this.rankMemories(records);
  }

  pruneLowValueMemories(threshold: number = 0.2): number {
    const lowValue = this.db.prepare(`
      SELECT memory_id FROM memory_policy WHERE reward < ?
    `).all(threshold) as Array<{ memory_id: string }>;

    let pruned = 0;
    for (const { memory_id } of lowValue) {
      try {
        this.db.prepare('DELETE FROM memory_rewards WHERE memory_id = ?').run(memory_id);
        this.db.prepare('DELETE FROM memory_policy WHERE memory_id = ?').run(memory_id);
        pruned++;
      } catch { /* skip */ }
    }

    return pruned;
  }

  getPolicyStats(): { avgReward: number; totalUpdates: number; prunedCount: number } {
    const row = this.db.prepare(`
      SELECT AVG(reward) as avg_reward, SUM(update_count) as total_updates
      FROM memory_policy
    `).get() as { avg_reward: number | null; total_updates: number | null };

    return {
      avgReward: row.avg_reward ?? 0.5,
      totalUpdates: row.total_updates ?? 0,
      prunedCount: 0,
    };
  }

  private updatePolicy(memoryId: string): void {
    const rewards = this.db.prepare(`
      SELECT utility_score FROM memory_rewards
      WHERE memory_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(memoryId, this.baselineWindow) as Array<{ utility_score: number }>;

    if (rewards.length === 0) return;

    const avgReward = rewards.reduce((sum, r) => sum + r.utility_score, 0) / rewards.length;
    const existing = this.getPolicy(memoryId);
    const oldReward = existing?.reward ?? 0.5;

    const advantage = avgReward - oldReward;
    const clippedAdvantage = Math.max(-this.clipEpsilon, Math.min(this.clipEpsilon, advantage));
    const newReward = Math.max(0, Math.min(1, oldReward + 0.1 * clippedAdvantage));

    this.db.prepare(`
      INSERT OR REPLACE INTO memory_policy (memory_id, reward, advantage, update_count, last_updated)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(memoryId, newReward, clippedAdvantage, (existing?.update_count ?? 0) + 1);
  }

  private getPolicy(memoryId: string): { reward: number; advantage: number; update_count: number } | null {
    const row = this.db.prepare('SELECT * FROM memory_policy WHERE memory_id = ?').get(memoryId) as {
      reward: number; advantage: number; update_count: number;
    } | undefined;
    return row ?? null;
  }

  private getBaselineReward(): number {
    const row = this.db.prepare('SELECT AVG(reward) as baseline FROM memory_policy').get() as { baseline: number | null };
    return row.baseline ?? 0.5;
  }
}
