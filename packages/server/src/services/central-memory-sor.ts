import type { Database } from 'better-sqlite3';
import { SqliteMemoryStore } from './memory-store';
import type { MemoryRecord } from './memory-store';

export interface MemoryStats {
  totalRecords: number; byType: Record<string, number>; bySource: Record<string, number>;
  avgConfidence: number; totalRelations: number;
}

export class CentralMemorySOR {
  private store: SqliteMemoryStore;
  constructor(private db: Database) { this.store = new SqliteMemoryStore(db); }

  ingest(record: Omit<MemoryRecord, 'id' | 'createdAt'>): MemoryRecord { return this.store.store(record); }
  ingestBatch(records: Array<Omit<MemoryRecord, 'id' | 'createdAt'>>): MemoryRecord[] { return records.map(r => this.store.store(r)); }
  query(q: { type?: string; source?: string; minConfidence?: number; limit?: number; query?: string }): MemoryRecord[] { return this.store.search({ type: q.type, source: q.source, minConfidence: q.minConfidence, limit: q.limit ?? 20, query: q.query }); }
  retrieve(id: string): MemoryRecord | null { return this.store.retrieve(id); }
  relate(fromId: string, toId: string, relationType: string, strength: number = 0.5) { return this.store.relate(fromId, toId, relationType, strength); }
  getGraph(rootId: string, depth: number = 2): MemoryRecord[] { return this.store.project(rootId, depth); }

  getStats(): MemoryStats {
    const records = this.store.search({ limit: 10000 });
    const byType: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    let totalConfidence = 0;
    for (const r of records) { byType[r.type] = (byType[r.type] || 0) + 1; bySource[r.source] = (bySource[r.source] || 0) + 1; totalConfidence += r.confidence; }
    let totalRelations = 0;
    try { const row = this.db.prepare('SELECT COUNT(*) as c FROM memory_relations').get() as { c: number }; totalRelations = row.c; } catch { /* ok */ }
    return { totalRecords: records.length, byType, bySource, avgConfidence: records.length > 0 ? totalConfidence / records.length : 0, totalRelations };
  }

  searchBySimilarity(content: string, limit: number = 10): MemoryRecord[] {
    const all = this.store.search({ limit: 1000 });
    const contentWords = new Set(content.toLowerCase().split(/s+/));
    const scored = all.map(record => {
      const recordWords = new Set(record.content.toLowerCase().split(/s+/));
      let intersection = 0;
      for (const word of contentWords) { if (recordWords.has(word)) intersection++; }
      const union = contentWords.size + recordWords.size - intersection;
      return { record, similarity: union === 0 ? 0 : intersection / union };
    });
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit).map(s => s.record);
  }

  deleteRecord(id: string): boolean {
    try { this.db.prepare('DELETE FROM memory_relations WHERE from_id = ? OR to_id = ?').run(id, id); this.db.prepare('DELETE FROM central_memories WHERE id = ?').run(id); return true; } catch { return false; }
  }
}
