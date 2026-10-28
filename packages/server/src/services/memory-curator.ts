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

  private findSimilar(episode: RawEpisode): MemoryRecord | null {
    const results = this.store.search({ source: episode.source, limit: 5 });
    for (const result of results) {
      if (this.similarity(result.content, episode.content) > 0.8) return result;
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
    let c = 0.5;
    if (episode.content.length > 100) c += 0.1;
    if (episode.content.length > 500) c += 0.1;
    if (episode.metadata && Object.keys(episode.metadata).length > 0) c += 0.1;
    if (episode.source.startsWith('verified:')) c += 0.2;
    return Math.min(1, c);
  }

  /**
   * L-F07: a merge is evidence bookkeeping, not corroboration, so it never changes confidence. Every episode that
   * reaches a merge shares the existing record's source (findSimilar only matches the same source), so it is not
   * independent evidence — a `verified:` label does not change that, nor does a fresh episode id. Re-ingesting an
   * already merged episode id is a no-op, identical content is not appended again, and differing (including
   * contradictory) content is appended so it stays visible. Merged episode ids are kept as provenance.
   */
  private merge(existing: MemoryRecord, episode: RawEpisode): MemoryRecord {
    const meta = existing.metadata ?? {};
    const episodeIds: string[] = Array.isArray(meta.episodeIds)
      ? meta.episodeIds as string[]
      : typeof meta.originalId === 'string' ? [meta.originalId] : [];
    if (episodeIds.includes(episode.id)) return existing;

    const repeatsContent = existing.content.split('\n\n--- Update ---\n\n').includes(episode.content);
    const updatedContent = repeatsContent ? existing.content : existing.content + '\n\n--- Update ---\n\n' + episode.content;
    const metadata = { ...meta, episodeIds: [...episodeIds, episode.id], lastMerge: episode.timestamp };
    this.db.prepare('UPDATE central_memories SET content = ?, metadata_json = ? WHERE id = ?')
      .run(updatedContent, JSON.stringify(metadata), existing.id);
    return { ...existing, content: updatedContent, metadata };
  }

  private similarity(a: string, b: string): number {
    const aWords = new Set(a.toLowerCase().split(/\s+/));
    const bWords = new Set(b.toLowerCase().split(/\s+/));
    let intersection = 0;
    for (const word of aWords) { if (bWords.has(word)) intersection++; }
    const union = aWords.size + bWords.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }
}
