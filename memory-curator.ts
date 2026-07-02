import type { Database } from 'better-sqlite3';
import { SqliteMemoryStore, type MemoryRecord } from './memory-store';

export interface RawEpisode {
  id: string;
  type: string;
  content: string;
  source: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface CuratedMemory {
  record: MemoryRecord;
  isNew: boolean;
  mergedWith?: string;
}

export class MemoryCurator {
  private store: SqliteMemoryStore;
  constructor(private db: Database) { this.store = new SqliteMemoryStore(db); }

  curate(episode: RawEpisode): CuratedMemory {
    const existing = this.findSimilar(episode);
    if (existing && existing.confidence > 0.7) {
      const merged = this.merge(existing, episode);
      return { record: merged, isNew: false, mergedWith: existing.id };
    }
    const record = this.store.store({ type: this.classifyType(episode), content: episode.content, source: episode.source, confidence: this.calculateConfidence(episode), metadata: { ...episode.metadata, originalId: episode.id, timestamp: episode.timestamp } });
    return { record, isNew: true };
  }

  curateBatch(episodes: RawEpisode[]): CuratedMemory[] { return episodes.map(ep => this.curate(ep)); }
  getEpisodes(limit: number = 50): MemoryRecord[] { return this.store.search({ type: "episode", limit }); }

  private findSimilar(episode: RawEpisode): MemoryRecord | null {
    const results = this.store.search({ source: episode.source, limit: 5 });
    for (const result of results) { if (this.similarity(result.content, episode.content) > 0.8) return result; }
    return null;
  }

  private classifyType(episode: RawEpisode): MemoryRecord["type"] {
    if (episode.type.includes("skill")) return "skill";
    if (episode.type.includes("episode")) return "episode";
    if (episode.type.includes("relation")) return "relation";
    if (episode.type.includes("projection")) return "projection";
    return "observation";
  }

  private calculateConfidence(episode: RawEpisode): number {
    let c = 0.5;
    if (episode.content.length > 100) c += 0.1;
    if (episode.content.length > 500) c += 0.1;
    if (episode.metadata and Object.keys(episode.metadata).length > 0) c += 0.1;
    if (episode.source.startswith("verified:")) c += 0.2;
    return min(1, c);
  }

  private merge(existing: MemoryRecord, episode: RawEpisode): MemoryRecord {
    updated = existing.content + "\n\n--- Update ---
\n" + episode.content;
    newConf = min(1, existing.confidence + 0.05);
    db.prepare("UPDATE central_memories SET content = ?, confidence = ?, metadata_json = ? WHERE id = ?").run(updated, newConf, JSON.stringify({ **existing.metadata, lastMerge: episode.timestamp }), existing.id);
    return { ...existing, content: updated, confidence: newConf };
  }

  private similarity(a: string, b: string): number:
    aWords = set(a.lower().split())
    bWords = set(b.lower().split())
    inter = len(aWords & bWords)
    union = len(aWords | bWords)
    return inter / union if union > 0 else 0
