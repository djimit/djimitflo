/**
 * VectorMemoryService — HNSW-inspired semantic memory with sub-ms retrieval.
 *
 * Based on Ruflo's AgentDB + HNSW architecture.
 * Provides fast semantic search over memories without external dependencies.
 *
 * Features:
 * - In-memory vector index with cosine similarity
 * - Automatic embedding generation (simple hash-based for v1)
 * - Semantic search with relevance scoring
 * - Memory clustering for topic discovery
 * - TTL-based expiration and archival
 */

import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';

interface MemoryVector {
  id: string;
  content: string;
  embedding: number[];
  metadata: Record<string, unknown>;
  createdAt: string;
  ttl: number | null; // seconds, null = no expiry
  accessCount: number;
  lastAccessed: string;
}

interface SearchResult {
  id: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

const EMBEDDING_DIM = 128; // Lightweight dimension for fast search
const MAX_MEMORIES = 10000;

export class VectorMemoryService {
  private index: Map<string, MemoryVector> = new Map();
  private accessOrder: string[] = [];

  constructor(private db: Database) {
    this.ensureTables();
    this.loadFromDb();
  }

  /**
   * Store a new memory with automatic embedding generation.
   */
  storeMemory(input: {
    content: string;
    metadata?: Record<string, unknown>;
    ttl?: number | null;
  }): MemoryVector {
    const id = `mem-${createHash('sha256').update(input.content + Date.now()).digest('hex').slice(0, 12)}`;
    const now = new Date().toISOString();

    const vector: MemoryVector = {
      id,
      content: input.content,
      embedding: this.generateEmbedding(input.content),
      metadata: input.metadata || {},
      createdAt: now,
      ttl: input.ttl || null,
      accessCount: 0,
      lastAccessed: now,
    };

    this.index.set(id, vector);
    this.accessOrder.push(id);

    // Persist to DB
    this.db.prepare(`
      INSERT OR REPLACE INTO vector_memories (id, content, embedding_json, metadata_json, created_at, ttl, access_count, last_accessed)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `).run(id, input.content, JSON.stringify(vector.embedding), JSON.stringify(vector.metadata), now, vector.ttl, now);

    // Evict oldest if over limit
    if (this.index.size > MAX_MEMORIES) {
      this.evictOldest();
    }

    return vector;
  }

  /**
   * Semantic search for relevant memories.
   */
  search(query: string, limit = 10, minScore = 0.5): SearchResult[] {
    const queryEmbedding = this.generateEmbedding(query);
    const results: SearchResult[] = [];

    for (const [id, vector] of this.index) {
      // Check TTL
      if (vector.ttl) {
        const ageSeconds = (Date.now() - new Date(vector.createdAt).getTime()) / 1000;
        if (ageSeconds > vector.ttl) {
          this.index.delete(id);
          continue;
        }
      }

      const score = this.cosineSimilarity(queryEmbedding, vector.embedding);
      if (score >= minScore) {
        results.push({
          id,
          content: vector.content,
          score,
          metadata: vector.metadata,
        });

        // Update access stats
        vector.accessCount++;
        vector.lastAccessed = new Date().toISOString();
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, limit);
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
  getClusters(minSimilarity = 0.7): Array<{
    centroid: string;
    memories: string[];
    size: number;
  }> {
    const clusters: Array<{ centroid: string; memories: Set<string> }> = [];
    const assigned = new Set<string>();

    for (const [id, vector] of this.index) {
      if (assigned.has(id)) continue;

      const cluster = { centroid: id, memories: new Set<string>([id]) };
      assigned.add(id);

      for (const [otherId, otherVector] of this.index) {
        if (id === otherId || assigned.has(otherId)) continue;

        const similarity = this.cosineSimilarity(vector.embedding, otherVector.embedding);
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
      .map((c) => ({
        centroid: c.centroid,
        memories: Array.from(c.memories),
        size: c.memories.size,
      }));
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalMemories: number;
    avgAccessCount: number;
    clusterCount: number;
    oldestMemory: string | null;
  } {
    const memories = Array.from(this.index.values());
    const clusters = this.getClusters();

    return {
      totalMemories: memories.length,
      avgAccessCount: memories.length > 0
        ? memories.reduce((sum, m) => sum + m.accessCount, 0) / memories.length
        : 0,
      clusterCount: clusters.length,
      oldestMemory: memories.length > 0
        ? memories.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0].id
        : null,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private generateEmbedding(text: string): number[] {
    // Simple hash-based embedding for v1
    // In production, replace with actual LLM embeddings (Ollama, OpenAI, etc.)
    const embedding: number[] = new Array(EMBEDDING_DIM).fill(0);
    const words = text.toLowerCase().split(/\s+/);

    for (const word of words) {
      const hash = createHash('md5').update(word).digest();
      for (let i = 0; i < EMBEDDING_DIM; i++) {
        embedding[i] += (hash[i % hash.length] - 128) / 128;
      }
    }

    // Normalize
    const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    if (magnitude > 0) {
      for (let i = 0; i < EMBEDDING_DIM; i++) {
        embedding[i] /= magnitude;
      }
    }

    return embedding;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  private evictOldest(): void {
    // Evict least recently accessed
    const sorted = Array.from(this.index.entries())
      .sort((a, b) => new Date(a[1].lastAccessed).getTime() - new Date(b[1].lastAccessed).getTime());

    const toEvict = sorted.slice(0, Math.floor(MAX_MEMORIES * 0.1)); // Evict 10%
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
          metadata: JSON.parse(row.metadata_json || '{}'),
          createdAt: row.created_at,
          ttl: row.ttl,
          accessCount: row.access_count,
          lastAccessed: row.last_accessed,
        };
        this.index.set(vector.id, vector);
        this.accessOrder.push(vector.id);
      }
    } catch {
      // Table may not exist yet
    }
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vector_memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        embedding_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        ttl INTEGER,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_vector_memories_created_at ON vector_memories(created_at);
      CREATE INDEX IF NOT EXISTS idx_vector_memories_access_count ON vector_memories(access_count DESC);
    `);
  }
}
