import type { Database } from "better-sqlite3";
import { randomUUID } from "crypto";
import type { MemoryRecord } from "./memory-store";

export interface RankedMemory { record: MemoryRecord; reward: number; rank: number; }

export class RLHFMemoryRanker {
  private clipEpsilon: number;
  private window: number;

  constructor(private db: Database, options: { clipEpsilon?: number; window?: number } = {}) {
    this.clipEpsilon = options.clipEpsilon ?? 0.2;
    this.window = options.window ?? 20;
    db.exec("CREATE TABLE IF NOT EXISTS memory_rewards (id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, loop_run_id TEXT NOT NULL, outcome TEXT NOT NULL, utility_score REAL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))");
    db.exec("CREATE TABLE IF NOT EXISTS memory_policy (memory_id TEXT PRIMARY KEY, reward REAL DEFAULT 0.5, advantage REAL DEFAULT 0, update_count INTEGER DEFAULT 0, last_updated TEXT DEFAULT (datetime('now')))");
  }

  recordReward(memoryId: string, loopRunId: string, outcome: string, utility: number): void {
    this.db.prepare("INSERT INTO memory_rewards (id, memory_id, loop_run_id, outcome, utility_score) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), memoryId, loopRunId, outcome, utility);
    this.updatePolicy(memoryId);
  }

  rank(memories: MemoryRecord[]): RankedMemory[] {
    const ranked = memories.map((record, i) => {
      const policy = this.getPolicy(record.id);
      return { record, reward: policy?.reward ?? 0.5, rank: i + 1 };
    });
    ranked.sort((a, b) => b.reward - a.reward);
    ranked.forEach((r, i) => { r.rank = i + 1; });
    return ranked;
  }

  getTop(limit: number = 10): RankedMemory[] {
    const rows = this.db.prepare("SELECT id, type, content, source, confidence, metadata_json, created_at FROM central_memories ORDER BY confidence DESC LIMIT ?").all(limit) as any[];
    const records: MemoryRecord[] = rows.map(m => ({ id: m.id, type: m.type, content: m.content, source: m.source, confidence: m.confidence, metadata: JSON.parse(m.metadata_json), createdAt: m.created_at }));
    return this.rank(records);
  }

  prune(threshold: number = 0.2): number {
    const low = this.db.prepare("SELECT memory_id FROM memory_policy WHERE reward < ?").all(threshold) as Array<{ memory_id: string }>;
    let count = 0;
    for (const { memory_id } of low) { try { this.db.prepare("DELETE FROM memory_rewards WHERE memory_id = ?").run(memory_id); this.db.prepare("DELETE FROM memory_policy WHERE memory_id = ?").run(memory_id); count++; } catch {} }
    return count;
  }

  stats(): { avgReward: number; totalUpdates: number } {
    const row = this.db.prepare("SELECT AVG(reward) as avg, SUM(update_count) as total FROM memory_policy").get() as any;
    return { avgReward: row.avg ?? 0.5, totalUpdates: row.total ?? 0 };
  }

  private updatePolicy(memoryId: string): void {
    const rewards = this.db.prepare("SELECT utility_score FROM memory_rewards WHERE memory_id = ? ORDER BY created_at DESC LIMIT ?").all(memoryId, this.window) as Array<{ utility_score: number }>;
    if (rewards.length === 0) return;
    const avg = rewards.reduce((s, r) => s + r.utility_score, 0) / rewards.length;
    const existing = this.getPolicy(memoryId);
    const oldReward = existing?.reward ?? 0.5;
    const advantage = avg - oldReward;
    const clipped = Math.max(-this.clipEpsilon, Math.min(this.clipEpsilon, advantage));
    const newReward = Math.max(0, Math.min(1, oldReward + 0.1 * clipped));
    this.db.prepare("INSERT OR REPLACE INTO memory_policy (memory_id, reward, advantage, update_count, last_updated) VALUES (?, ?, ?, ?, datetime('now'))").run(memoryId, newReward, clipped, (existing?.update_count ?? 0) + 1);
  }

  private getPolicy(memoryId: string): { reward: number; advantage: number; update_count: number } | null {
    const row = this.db.prepare("SELECT * FROM memory_policy WHERE memory_id = ?").get(memoryId) as any;
    return row ? { reward: row.reward, advantage: row.advantage, update_count: row.update_count } : null;
  }
}