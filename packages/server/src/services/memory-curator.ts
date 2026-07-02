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

  constructor(private db: Database) {
    this.store = new SqliteMemoryStore(db);
  }

  curate(episode: RawEpisode): CuratedMemory {
    const existing = this.findSimilar(episode);

    if (existing && existing.confidence > 0.7) {
      const merged = this.merge(existing, episode);
      return { record: merged, isNew: false, mergedWith: existing.id };
    }

    const record = this.store.store({
      type: this.classifyType(episode),
      content: episode.content,
      source: episode.source,
      confidence: this.calculateConfidence(episode),
      metadata: { ...episode.metadata, originalId: episode.id, timestamp: episode.timestamp },
    });

    return { record, isNew: true };
  }

  curateBatch(episodes: RawEpisode[]): CuratedMemory[] {
    return episodes.map(ep => this.curate(ep));
  }

  getEpisodes(limit: number = 50): MemoryRecord[] {
    return this.store.search({ type: 'episode', limit });
  }

  getSkills(limit: number = 50): MemoryRecord[] {
    return this.store.search({ type: 'skill', limit });
  }

  findSimilar(episode: RawEpisode): MemoryRecord | null {
    const results = this.store.search({ source: episode.source, limit: 5 });
    for (const result of results) {
      if (this.similarity(result.content, episode.content) > 0.8) {
        return result;
      }
    }
    return null;
  }

  private classifyType(episode: RawEpisode): MemoryRecord['type'] {
    if (episode.type.includes('skill')) return 'skill';
    if (episode.type.includes('episode')) return 'episode';
    if (episode.type.includes('relation')) return 'relation';
    if (episode.type.includes('projection')) return 'projection';
    return 'observation';
  }

  private calculateConfidence(episode: RawEpisode): number {
    let confidence = 0.5;
    if (episode.content.length > 100) confidence += 0.1;
    if (episode.content.length > 500) confidence += 0.1;
    if (episode.metadata && Object.keys(episode.metadata).length > 0) confidence += 0.1;
    if (episode.source.startsWith('verified:')) confidence += 0.2;
    return Math.min(1, confidence);
  }

  private merge(existing: MemoryRecord, episode: RawEpisode): MemoryRecord {
    const updatedContent = existing.content + '\n\n--- Update ---\n\n' + episode.content;
    const newConfidence = Math.min(1, existing.confidence + 0.05);

    this.db.prepare('UPDATE central_memories SET content = ?, confidence = ?, metadata_json = ? WHERE id = ?')
      .run(updatedContent, newConfidence, JSON.stringify({ ...existing.metadata, lastMerge: episode.timestamp }), existing.id);

    return { ...existing, content: updatedContent, confidence: newConfidence };
  }

  private similarity(a: string, b: string): number {
    const aWords = new Set(a.toLowerCase().split(/\s+/));
    const bWords = new Set(b.toLowerCase().split(/\s+/));
    let intersection = 0;
    for (const word of aWords) {
      if (bWords.has(word)) intersection++;
    }
    const union = aWords.size + bWords.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }
}
