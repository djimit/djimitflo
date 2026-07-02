import type { Database } from 'better-sqlite3';
import { SqliteMemoryStore } from './memory-store';
import { SkillPatternMiner } from './skill-pattern-miner';

export interface SwarmEpisodeInput {
  id: string; topic: string; domains: string[];
  participants: Array<{ agentId: string; role: string; output: string }>;
  outcome: 'success' | 'failure' | 'partial'; durationMs: number;
  metadata?: Record<string, unknown>;
}

export interface FactoryResult {
  episodeId: string; memoriesStored: number; patternsExtracted: number; skillCandidates: number;
}

export class SwarmMemoryFactory {
  private store: SqliteMemoryStore;
  private miner: SkillPatternMiner;
  constructor(private db: Database) {
    this.store = new SqliteMemoryStore(db);
    this.miner = new SkillPatternMiner(db);
    this.db.exec("CREATE TABLE IF NOT EXISTS swarm_episodes (id TEXT PRIMARY KEY, topic TEXT NOT NULL, domains_json TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')))");
  }

  processEpisode(input: SwarmEpisodeInput): FactoryResult {
    const episodeMemory = this.store.store({ type: 'episode', content: 'Swarm: ' + input.topic, source: 'swarm-episode', confidence: input.outcome === 'success' ? 0.9 : 0.5, metadata: { participantCount: input.participants.length } });
    for (const p of input.participants) {
      this.store.store({ type: 'observation', content: p.output, source: 'agent:' + p.agentId, confidence: 0.7, metadata: { role: p.role, episodeId: input.id } });
      this.store.relate(episodeMemory.id, p.agentId, 'contains', 0.9);
    }
    const patterns = this.miner.mineFromEpisode({ id: input.id, topic: input.topic, domains: input.domains, steps: input.participants.map(p => ({ role: p.role, action: p.output.slice(0, 50), outcome: input.outcome === 'success' ? 'success' : 'failure' })), success: input.outcome === 'success', durationMs: input.durationMs });
    this.db.prepare('INSERT OR REPLACE INTO swarm_episodes (id, topic, domains_json, outcome, duration_ms, metadata_json) VALUES (?, ?, ?, ?, ?, ?)').run(input.id, input.topic, JSON.stringify(input.domains), input.outcome, input.durationMs, JSON.stringify(input.metadata || {}));
    return { episodeId: input.id, memoriesStored: 1 + input.participants.length, patternsExtracted: patterns.length, skillCandidates: patterns.length };
  }

  getStats(): { totalEpisodes: number; totalPatterns: number; successRate: number } {
    const episodes = this.db.prepare('SELECT outcome FROM swarm_episodes').all() as Array<{ outcome: string }>;
    const patterns = this.miner.getPatterns(1, 1000);
    return { totalEpisodes: episodes.length, totalPatterns: patterns.length, successRate: episodes.length > 0 ? episodes.filter(e => e.outcome === 'success').length / episodes.length : 0 };
  }
}
