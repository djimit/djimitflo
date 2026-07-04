/**
 * ProactiveMemoryService — relevance-scored, self-maintaining memory substrate.
 *
 * Transforms memory from "storage" to "cognitive substrate":
 * 1. Relevance scoring — each memory scored by recency, usage, semantic similarity
 * 2. Proactive promotion — high-relevance candidates auto-promoted
 * 3. Decay & archival — TTL-based expiration with cold storage
 * 4. Memory graph — connect related memories into navigable structure
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

interface MemoryEntry {
  id: string;
  content: string;
  type: string;
  status: 'candidate' | 'active' | 'archived' | 'decay';
  relevanceScore: number;
  usageCount: number;
  lastAccessedAt: string;
  createdAt: string;
  expiresAt: string | null;
  metadata: Record<string, unknown>;
}

interface MemoryRelation {
  id: string;
  sourceId: string;
  targetId: string;
  relationType: string;
  strength: number;
  createdAt: string;
}

interface MemoryPromotionResult {
  promoted: number;
  archived: number;
  decayed: number;
  evaluated: number;
}

const DEFAULT_TTL_DAYS = 90;
const PROMOTION_THRESHOLD = 0.7;
const ARCHIVAL_THRESHOLD = 0.2;
// const DECAY_THRESHOLD = 0.1;  // Reserved for future use

export class ProactiveMemoryService {
  constructor(private db: Database) {
    this.ensureTables();
  }

  /**
   * Store a new memory entry with initial relevance scoring.
   */
  storeMemory(input: {
    content: string;
    type: string;
    metadata?: Record<string, unknown>;
    ttlDays?: number;
  }): MemoryEntry {
    const id = randomUUID();
    const now = new Date().toISOString();
    const ttlDays = input.ttlDays || DEFAULT_TTL_DAYS;
    const expiresAt = new Date(Date.now() + ttlDays * 86400000).toISOString();

    const entry: MemoryEntry = {
      id,
      content: input.content,
      type: input.type,
      status: 'candidate',
      relevanceScore: 0.5, // Initial neutral score
      usageCount: 0,
      lastAccessedAt: now,
      createdAt: now,
      expiresAt,
      metadata: input.metadata || {},
    };

    this.db.prepare(`
      INSERT INTO proactive_memories (
        id, content, type, status, relevance_score, usage_count,
        last_accessed_at, created_at, expires_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id, entry.content, entry.type, entry.status,
      entry.relevanceScore, entry.usageCount, entry.lastAccessedAt,
      entry.createdAt, entry.expiresAt, JSON.stringify(entry.metadata),
    );

    return entry;
  }

  /**
   * Access a memory (increments usage count, updates relevance).
   */
  accessMemory(id: string): MemoryEntry | null {
    const row = this.db.prepare('SELECT * FROM proactive_memories WHERE id = ?').get(id) as any;
    if (!row) return null;

    const now = new Date().toISOString();
    const newCount = (row.usage_count || 0) + 1;

    // Recency boost: more recent = higher score
    const ageDays = (Date.now() - new Date(row.created_at).getTime()) / 86400000;
    const recencyBoost = Math.max(0, 1 - (ageDays / DEFAULT_TTL_DAYS));

    // Usage boost: more used = higher score (diminishing returns)
    const usageBoost = Math.min(1, Math.log2(newCount + 1) / 5);

    const newScore = Math.min(1, (recencyBoost * 0.4) + (usageBoost * 0.4) + (row.relevance_score * 0.2));

    this.db.prepare(`
      UPDATE proactive_memories
      SET usage_count = ?, last_accessed_at = ?, relevance_score = ?
      WHERE id = ?
    `).run(newCount, now, newScore, id);

    return this.parseMemory(row, newCount, newScore);
  }

  /**
   * Run the proactive memory maintenance cycle.
   * Evaluates all memories and promotes/archives/decays based on relevance.
   */
  runMaintenanceCycle(): MemoryPromotionResult {
    const memories = this.db.prepare(`
      SELECT * FROM proactive_memories WHERE status IN ('candidate', 'active')
    `).all() as any[];

    let promoted = 0;
    let archived = 0;
    let decayed = 0;

    for (const row of memories) {
      const memory = this.parseMemory(row);
      const newScore = this.calculateRelevance(memory);

      // Update relevance score
      this.db.prepare('UPDATE proactive_memories SET relevance_score = ? WHERE id = ?').run(newScore, memory.id);

      // Promote high-relevance candidates
      if (memory.status === 'candidate' && newScore >= PROMOTION_THRESHOLD) {
        this.db.prepare("UPDATE proactive_memories SET status = 'active' WHERE id = ?").run(memory.id);
        promoted++;
      }

      // Archive low-relevance active memories
      if (memory.status === 'active' && newScore < ARCHIVAL_THRESHOLD) {
        this.db.prepare("UPDATE proactive_memories SET status = 'archived' WHERE id = ?").run(memory.id);
        archived++;
      }

      // Decay expired memories
      if (memory.expiresAt && new Date(memory.expiresAt) < new Date()) {
        this.db.prepare("UPDATE proactive_memories SET status = 'decay' WHERE id = ?").run(memory.id);
        decayed++;
      }
    }

    return { promoted, archived, decayed, evaluated: memories.length };
  }

  /**
   * Create a relation between two memories.
   */
  createRelation(sourceId: string, targetId: string, relationType: string, strength = 0.5): MemoryRelation {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO memory_relations (id, source_id, target_id, relation_type, strength, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, sourceId, targetId, relationType, strength, now);

    return { id, sourceId, targetId, relationType, strength, createdAt: now };
  }

  /**
   * Get related memories for a given memory ID.
   */
  getRelatedMemories(memoryId: string): Array<MemoryEntry & { relationType: string; strength: number }> {
    const relations = this.db.prepare(`
      SELECT m.*, r.relation_type, r.strength
      FROM proactive_memories m
      JOIN memory_relations r ON (r.target_id = m.id OR r.source_id = m.id)
      WHERE (r.source_id = ? OR r.target_id = ?) AND m.id != ?
      ORDER BY r.strength DESC
      LIMIT 20
    `).all(memoryId, memoryId, memoryId) as any[];

    return relations.map((r) => ({
      ...this.parseMemory(r),
      relationType: r.relation_type,
      strength: r.strength,
    }));
  }

  /**
   * Get the most relevant active memories.
   */
  getTopMemories(limit = 20, type?: string): MemoryEntry[] {
    let query = 'SELECT * FROM proactive_memories WHERE status = ?';
    const params: unknown[] = ['active'];

    if (type) {
      query += ' AND type = ?';
      params.push(type);
    }

    query += ' ORDER BY relevance_score DESC, usage_count DESC LIMIT ?';
    params.push(limit);

    return (this.db.prepare(query).all(...params) as any[]).map((r) => this.parseMemory(r));
  }

  /**
   * Search memories by content similarity (simple keyword match for v1).
   */
  searchMemories(query: string, limit = 10): MemoryEntry[] {
    const keywords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (keywords.length === 0) return [];

    const conditions = keywords.map(() => 'content LIKE ?').join(' OR ');
    const params = keywords.map((k) => `%${k}%`);

    return (this.db.prepare(`
      SELECT * FROM proactive_memories
      WHERE status = 'active' AND (${conditions})
      ORDER BY relevance_score DESC LIMIT ?
    `).all(...params, limit) as any[]).map((r) => this.parseMemory(r));
  }

  /**
   * Get memory statistics.
   */
  getStats(): {
    total: number;
    active: number;
    candidates: number;
    archived: number;
    decayed: number;
    avgRelevance: number;
    totalRelations: number;
  } {
    const total = (this.db.prepare('SELECT COUNT(*) as c FROM proactive_memories').get() as any)?.c || 0;
    const active = (this.db.prepare("SELECT COUNT(*) as c FROM proactive_memories WHERE status = 'active'").get() as any)?.c || 0;
    const candidates = (this.db.prepare("SELECT COUNT(*) as c FROM proactive_memories WHERE status = 'candidate'").get() as any)?.c || 0;
    const archived = (this.db.prepare("SELECT COUNT(*) as c FROM proactive_memories WHERE status = 'archived'").get() as any)?.c || 0;
    const decayed = (this.db.prepare("SELECT COUNT(*) as c FROM proactive_memories WHERE status = 'decay'").get() as any)?.c || 0;
    const avgRel = (this.db.prepare('SELECT AVG(relevance_score) as avg FROM proactive_memories').get() as any)?.avg || 0;
    const relations = (this.db.prepare('SELECT COUNT(*) as c FROM memory_relations').get() as any)?.c || 0;

    return { total, active, candidates, archived, decayed, avgRelevance: avgRel, totalRelations: relations };
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private calculateRelevance(memory: MemoryEntry): number {
    const ageDays = (Date.now() - new Date(memory.createdAt).getTime()) / 86400000;
    const recencyBoost = Math.max(0, 1 - (ageDays / DEFAULT_TTL_DAYS));
    const usageBoost = Math.min(1, Math.log2(memory.usageCount + 1) / 5);
    return Math.min(1, (recencyBoost * 0.4) + (usageBoost * 0.4) + (memory.relevanceScore * 0.2));
  }

  private parseMemory(row: any, usageCount?: number, relevanceScore?: number): MemoryEntry {
    return {
      id: row.id,
      content: row.content,
      type: row.type,
      status: row.status,
      relevanceScore: relevanceScore ?? row.relevance_score,
      usageCount: usageCount ?? row.usage_count,
      lastAccessedAt: row.last_accessed_at,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      metadata: JSON.parse(row.metadata_json || '{}'),
    };
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS proactive_memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'observation',
        status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate', 'active', 'archived', 'decay')),
        relevance_score REAL NOT NULL DEFAULT 0.5 CHECK(relevance_score >= 0 AND relevance_score <= 1),
        usage_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_proactive_memories_status ON proactive_memories(status);
      CREATE INDEX IF NOT EXISTS idx_proactive_memories_type ON proactive_memories(type);
      CREATE INDEX IF NOT EXISTS idx_proactive_memories_relevance ON proactive_memories(relevance_score DESC);
      CREATE INDEX IF NOT EXISTS idx_proactive_memories_expires ON proactive_memories(expires_at);

      CREATE TABLE IF NOT EXISTS memory_relations (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation_type TEXT NOT NULL DEFAULT 'related',
        strength REAL NOT NULL DEFAULT 0.5 CHECK(strength >= 0 AND strength <= 1),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (source_id) REFERENCES proactive_memories(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES proactive_memories(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_memory_relations_source ON memory_relations(source_id);
      CREATE INDEX IF NOT EXISTS idx_memory_relations_target ON memory_relations(target_id);
    `);
  }
}
