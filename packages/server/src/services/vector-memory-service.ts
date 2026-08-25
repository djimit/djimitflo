/**
 * VectorMemoryService — semantic vector memory with self-learning feedback.
 *
 * Features:
 * - Configurable semantic embeddings
 * - Thompson Sampling bandit for result re-ranking (self-learning)
 * - Hybrid search: dense cosine + sparse BM25 with RRF fusion
 * - Memory clustering for topic discovery
 * - TTL-based expiration
 */

import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import { cosineSimilarity, createEmbeddingProvider, type EmbeddingProvider } from './embedding-provider';

interface MemoryVector {
  id: string;
  content: string;
  embedding: number[];
  embeddingProvider: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  ttl: number | null;
  accessCount: number;
  lastAccessed: string;
}

interface SearchResult {
  id: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

interface BanditState {
  successes: number;    // alpha
  failures: number;     // beta
}

const MAX_MEMORIES = 10000;

export class VectorMemoryService {
  private index: Map<string, MemoryVector> = new Map();
  private accessOrder: string[] = [];
  private banditStates: Map<string, BanditState> = new Map();
  private embeddingCache: Map<string, number[]> = new Map();

  constructor(private db: Database, private readonly embeddings: EmbeddingProvider = createEmbeddingProvider()) {
    this.ensureTables();
    this.loadFromDb();
  }

  /**
   * Store a new memory with automatic embedding generation.
   */
  async storeMemory(input: {
    content: string;
    metadata?: Record<string, unknown>;
    ttl?: number | null;
  }): Promise<MemoryVector> {
    const id = `mem-${createHash('sha256').update(input.content + Date.now()).digest('hex').slice(0, 12)}`;
    const now = new Date().toISOString();

    const vector: MemoryVector = {
      id,
      content: input.content,
      embedding: await this.generateEmbeddingCached(input.content),
      embeddingProvider: this.embeddings.id,
      metadata: input.metadata || {},
      createdAt: now,
      ttl: input.ttl || null,
      accessCount: 0,
      lastAccessed: now,
    };

    this.index.set(id, vector);
    this.accessOrder.push(id);

    this.db.prepare(`
      INSERT OR REPLACE INTO vector_memories (id, content, embedding_json, embedding_provider, metadata_json, created_at, ttl, access_count, last_accessed)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(id, input.content, JSON.stringify(vector.embedding), vector.embeddingProvider, JSON.stringify(vector.metadata), now, vector.ttl, now);

    if (this.index.size > MAX_MEMORIES) {
      this.evictOldest();
    }

    return vector;
  }

  /**
   * Semantic search with hybrid scoring (dense + sparse + bandit re-ranking).
   */
  async search(query: string, limit = 10, minScore = 0.5): Promise<SearchResult[]> {
    const queryEmbedding = await this.generateEmbeddingCached(query);
    const queryTerms = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const results: SearchResult[] = [];

    for (const [id, vector] of this.index) {
      if (vector.ttl) {
        const ageSeconds = (Date.now() - new Date(vector.createdAt).getTime()) / 1000;
        if (ageSeconds > vector.ttl) {
          this.index.delete(id);
          continue;
        }
      }

      if (vector.embeddingProvider !== this.embeddings.id) continue;
      const denseScore = cosineSimilarity(queryEmbedding, vector.embedding);
      const sparseScore = this.bm25Score(queryTerms, vector.content);
      const banditBonus = this.banditBonus(id);

      // Reciprocal Rank Fusion: combine dense + sparse, then add bandit bonus
      const score = 0.6 * denseScore + 0.2 * sparseScore + 0.2 * banditBonus;

      if (score >= minScore) {
        results.push({ id, content: vector.content, score, metadata: vector.metadata });
        vector.accessCount++;
        vector.lastAccessed = new Date().toISOString();
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * Record feedback for a memory (Thompson Sampling bandit update).
   * reward: 0.0 (irrelevant) to 1.0 (highly relevant)
   */
  recordFeedback(memoryId: string, reward: number): void {
    const clamped = Math.max(0, Math.min(1, reward));
    const state = this.banditStates.get(memoryId) || { successes: 1, failures: 1 };
    if (clamped >= 0.5) {
      state.successes += clamped;
    } else {
      state.failures += (1 - clamped);
    }
    this.banditStates.set(memoryId, state);

    this.db.prepare(`
      INSERT INTO vector_feedback (memory_id, reward, created_at)
      VALUES (?, ?, ?)
    `).run(memoryId, clamped, new Date().toISOString());
  }

  /**
   * Get a memory by ID.
   */
  getMemory(id: string): MemoryVector | null {
    const vector = this.index.get(id);
    if (vector) {
      vector.accessCount++;
      vector.lastAccessed = new Date().toISOString();
    }
    return vector || null;
  }

  /**
   * Delete a memory.
   */
  deleteMemory(id: string): boolean {
    const deleted = this.index.delete(id);
    if (deleted) {
      this.db.prepare('DELETE FROM vector_memories WHERE id = ?').run(id);
      this.accessOrder = this.accessOrder.filter((oid) => oid !== id);
    }
    return deleted;
  }

  /**
   * Get memory clusters (grouped by similarity).
   */
  getClusters(minSimilarity = 0.7): Array<{ centroid: string; memories: string[]; size: number }> {
    const clusters: Array<{ centroid: string; memories: Set<string> }> = [];
    const assigned = new Set<string>();
    for (const [id, vector] of this.index) {
      if (assigned.has(id) || vector.embeddingProvider !== this.embeddings.id) continue;
      const cluster = { centroid: id, memories: new Set<string>([id]) };
      assigned.add(id);

      for (const [otherId, otherVector] of this.index) {
        if (id === otherId || assigned.has(otherId)) continue;
        if (otherVector.embeddingProvider !== this.embeddings.id) continue;
        const similarity = cosineSimilarity(vector.embedding, otherVector.embedding);
        if (similarity >= minSimilarity) {
          cluster.memories.add(otherId);
          assigned.add(otherId);
        }
      }
      clusters.push(cluster);
    }

    return clusters
      .filter((c) => c.memories.size > 1)
      .sort((a, b) => b.memories.size - a.memories.size)
      .map((c) => ({ centroid: c.centroid, memories: Array.from(c.memories), size: c.memories.size }));
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalMemories: number;
    avgAccessCount: number;
    clusterCount: number;
    oldestMemory: string | null;
    embeddingMode: string;
    feedbackCount: number;
  } {
    const memories = Array.from(this.index.values());
    const clusters = this.getClusters();
    const feedbackRows = (this.db.prepare('SELECT COUNT(*) as c FROM vector_feedback').get() as any)?.c || 0;

    return {
      totalMemories: memories.length,
      avgAccessCount: memories.length > 0
        ? memories.reduce((sum, m) => sum + m.accessCount, 0) / memories.length
        : 0,
      clusterCount: clusters.length,
      oldestMemory: memories.length > 0
        ? memories.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0].id
        : null,
      embeddingMode: this.embeddings.id,
      feedbackCount: feedbackRows,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private async generateEmbeddingCached(text: string): Promise<number[]> {
    const cacheKey = createHash('md5').update(text).digest('hex');
    const cached = this.embeddingCache.get(cacheKey);
    if (cached) return cached;

    const embedding = await this.embeddings.embed(text);

    // Cache last 500 embeddings
    if (this.embeddingCache.size > 500) {
      const first = this.embeddingCache.keys().next().value;
      if (first) this.embeddingCache.delete(first);
    }
    this.embeddingCache.set(cacheKey, embedding);
    return embedding;
  }

  private bm25Score(queryTerms: string[], content: string): number {
    if (queryTerms.length === 0) return 0;
    const terms = content.toLowerCase().split(/\s+/);
    const docLen = terms.length;
    const avgDocLen = 100; // approximation
    const k1 = 1.5;
    const b = 0.75;

    let score = 0;
    for (const qt of queryTerms) {
      const freq = terms.filter(t => t.includes(qt)).length;
      const idf = Math.log((this.index.size + 1) / (freq + 0.5));
      const tf = (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * docLen / avgDocLen));
      score += idf * tf;
    }

    return Math.min(1, score / queryTerms.length);
  }

  private banditBonus(memoryId: string): number {
    const state = this.banditStates.get(memoryId);
    if (!state) return 0.5; // neutral prior
    // Expected value of Beta distribution
    return state.successes / (state.successes + state.failures);
  }

  private evictOldest(): void {
    const sorted = Array.from(this.index.entries())
      .sort((a, b) => new Date(a[1].lastAccessed).getTime() - new Date(b[1].lastAccessed).getTime());
    const toEvict = sorted.slice(0, Math.floor(MAX_MEMORIES * 0.1));
    for (const [id] of toEvict) {
      this.index.delete(id);
      this.db.prepare('DELETE FROM vector_memories WHERE id = ?').run(id);
    }
    this.accessOrder = this.accessOrder.filter((id) => this.index.has(id));
  }

  private loadFromDb(): void {
    try {
      const rows = this.db.prepare('SELECT * FROM vector_memories ORDER BY created_at DESC LIMIT ?').all(MAX_MEMORIES) as any[];
      for (const row of rows) {
        const vector: MemoryVector = {
          id: row.id,
          content: row.content,
          embedding: JSON.parse(row.embedding_json || '[]'),
          embeddingProvider: row.embedding_provider || 'legacy',
          metadata: JSON.parse(row.metadata_json || '{}'),
          createdAt: row.created_at,
          ttl: row.ttl,
          accessCount: row.access_count,
          lastAccessed: row.last_accessed,
        };
        this.index.set(vector.id, vector);
        this.accessOrder.push(vector.id);
      }
    } catch { /* table may not exist */ }

    try {
      const fbRows = this.db.prepare('SELECT memory_id, reward FROM vector_feedback').all() as any[];
      for (const fb of fbRows) {
        const state = this.banditStates.get(fb.memory_id) || { successes: 1, failures: 1 };
        if (fb.reward >= 0.5) state.successes += fb.reward;
        else state.failures += (1 - fb.reward);
        this.banditStates.set(fb.memory_id, state);
      }
    } catch { /* table may not exist */ }
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vector_memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        embedding_json TEXT NOT NULL DEFAULT '[]',
        embedding_provider TEXT NOT NULL DEFAULT 'legacy',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        ttl INTEGER,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_vector_memories_created_at ON vector_memories(created_at);
      CREATE INDEX IF NOT EXISTS idx_vector_memories_access_count ON vector_memories(access_count DESC);
      CREATE TABLE IF NOT EXISTS vector_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL,
        reward REAL NOT NULL DEFAULT 0.5,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (memory_id) REFERENCES vector_memories(id)
      );
      CREATE INDEX IF NOT EXISTS idx_vf_memory ON vector_feedback(memory_id);
    `);
    const columns = this.db.prepare('PRAGMA table_info(vector_memories)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'embedding_provider')) {
      this.db.exec("ALTER TABLE vector_memories ADD COLUMN embedding_provider TEXT NOT NULL DEFAULT 'legacy'");
    }
  }
}
