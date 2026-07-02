import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface MemoryRecord {
  id: string;
  type: 'episode' | 'skill' | 'relation' | 'projection' | 'observation';
  content: string;
  source: string;
  confidence: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface MemoryRelation {
  id: string;
  fromId: string;
  toId: string;
  relationType: string;
  strength: number;
}

export interface SearchQuery {
  type?: string;
  source?: string;
  minConfidence?: number;
  limit?: number;
  query?: string;
}

export interface MemoryStore {
  store(record: Omit<MemoryRecord, 'id' | 'createdAt'>): MemoryRecord;
  retrieve(id: string): MemoryRecord | null;
  search(query: SearchQuery): MemoryRecord[];
  relate(fromId: string, toId: string, relationType: string, strength: number): MemoryRelation;
  getRelations(id: string): MemoryRelation[];
  project(id: string, depth: number): MemoryRecord[];
}

interface MemoryRow {
  id: string; type: string; content: string; source: string;
  confidence: number; metadata_json: string; created_at: string;
}

interface RelationRow {
  id: string; from_id: string; to_id: string; relation_type: string; strength: number;
}

export class SqliteMemoryStore implements MemoryStore {
  constructor(private db: Database) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS central_memories (id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.5, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS memory_relations (id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, relation_type TEXT NOT NULL, strength REAL NOT NULL DEFAULT 0.5, created_at TEXT NOT NULL DEFAULT (datetime('now')), FOREIGN KEY (from_id) REFERENCES central_memories(id), FOREIGN KEY (to_id) REFERENCES central_memories(id))`);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_cm_type ON central_memories(type)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_mr_from ON memory_relations(from_id)');
  }

  store(record: Omit<MemoryRecord, 'id' | 'createdAt'>): MemoryRecord {
    const id = randomUUID();
    this.db.prepare('INSERT INTO central_memories (id, type, content, source, confidence, metadata_json) VALUES (?, ?, ?, ?, ?, ?)').run(id, record.type, record.content, record.source, record.confidence, JSON.stringify(record.metadata));
    return { ...record, id, createdAt: new Date().toISOString() };
  }

  retrieve(id: string): MemoryRecord | null {
    const row = this.db.prepare('SELECT * FROM central_memories WHERE id = ?').get(id) as MemoryRow | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  search(query: SearchQuery): MemoryRecord[] {
    let sql = 'SELECT * FROM central_memories WHERE 1=1';
    const params: unknown[] = [];
    if (query.type) { sql += ' AND type = ?'; params.push(query.type); }
    if (query.source) { sql += ' AND source = ?'; params.push(query.source); }
    if (query.minConfidence != null) { sql += ' AND confidence >= ?'; params.push(query.minConfidence); }
    if (query.query) { sql += ' AND content LIKE ?'; params.push(`%${query.query}%`); }
    sql += ' ORDER BY confidence DESC, created_at DESC';
    if (query.limit) { sql += ' LIMIT ?'; params.push(query.limit); }
    return (this.db.prepare(sql).all(...params) as MemoryRow[]).map(this.rowToRecord);
  }

  relate(fromId: string, toId: string, relationType: string, strength: number): MemoryRelation {
    const id = randomUUID();
    this.db.prepare('INSERT INTO memory_relations (id, from_id, to_id, relation_type, strength) VALUES (?, ?, ?, ?, ?)').run(id, fromId, toId, relationType, strength);
    return { id, fromId, toId, relationType, strength };
  }

  getRelations(id: string): MemoryRelation[] {
    return (this.db.prepare('SELECT * FROM memory_relations WHERE from_id = ? OR to_id = ? ORDER BY strength DESC').all(id, id) as RelationRow[]).map(r => ({ id: r.id, fromId: r.from_id, toId: r.to_id, relationType: r.relation_type, strength: r.strength }));
  }

  project(id: string, depth: number): MemoryRecord[] {
    const visited = new Set<string>();
    const results: MemoryRecord[] = [];
    const visit = (curr: string, d: number) => {
      if (d > depth || visited.has(curr)) return;
      visited.add(curr);
      const rec = this.retrieve(curr);
      if (rec) results.push(rec);
      if (d < depth) for (const rel of this.getRelations(curr)) visit(rel.fromId === curr ? rel.toId : rel.fromId, d + 1);
    };
    visit(id, 0);
    return results;
  }

  private rowToRecord(row: MemoryRow): MemoryRecord {
    return { id: row.id, type: row.type as MemoryRecord['type'], content: row.content, source: row.source, confidence: row.confidence, metadata: JSON.parse(row.metadata_json), createdAt: row.created_at };
  }
}

export class InMemoryMemoryStore implements MemoryStore {
  private memories = new Map<string, MemoryRecord>();
  private relations = new Map<string, MemoryRelation>();

  store(record: Omit<MemoryRecord, 'id' | 'createdAt'>): MemoryRecord {
    const full: MemoryRecord = { ...record, id: randomUUID(), createdAt: new Date().toISOString() };
    this.memories.set(full.id, full);
    return full;
  }

  retrieve(id: string): MemoryRecord | null { return this.memories.get(id) ?? null; }

  search(query: SearchQuery): MemoryRecord[] {
    let results = [...this.memories.values()];
    if (query.type) results = results.filter(r => r.type === query.type);
    if (query.source) results = results.filter(r => r.source === query.source);
    if (query.minConfidence != null) results = results.filter(r => r.confidence >= query.minConfidence!);
    if (query.query) results = results.filter(r => r.content.toLowerCase().includes(query.query!.toLowerCase()));
    results.sort((a, b) => b.confidence - a.confidence);
    if (query.limit) results = results.slice(0, query.limit);
    return results;
  }

  relate(fromId: string, toId: string, relationType: string, strength: number): MemoryRelation {
    const rel: MemoryRelation = { id: randomUUID(), fromId, toId, relationType, strength };
    this.relations.set(rel.id, rel);
    return rel;
  }

  getRelations(id: string): MemoryRelation[] {
    return [...this.relations.values()].filter(r => r.fromId === id || r.toId === id);
  }

  project(id: string, depth: number): MemoryRecord[] {
    const visited = new Set<string>();
    const results: MemoryRecord[] = [];
    const visit = (curr: string, d: number) => {
      if (d > depth || visited.has(curr)) return;
      visited.add(curr);
      const rec = this.memories.get(curr);
      if (rec) results.push(rec);
      if (d < depth) for (const rel of this.relations.values()) {
        if (rel.fromId === curr) visit(rel.toId, d + 1);
        if (rel.toId === curr) visit(rel.fromId, d + 1);
      }
    };
    visit(id, 0);
    return results;
  }
}
