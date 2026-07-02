import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { SkillPatternMiner, type SkillPattern, type SwarmEpisode } from './skill-pattern-miner';

export interface ContrastivePattern extends SkillPattern {
  embedding: number[];
  clusterId: string | null;
  similarityScore: number;
}

export interface ClusterResult {
  clusterId: string;
  patterns: ContrastivePattern[];
  centroid: number[];
  coherence: number;
}

export class ContrastiveSkillMiner {
  private miner: SkillPatternMiner;
  private similarityThreshold: number;
  private embeddingDimension: number;

  constructor(
    private db: Database,
    options: { similarityThreshold?: number; embeddingDimension?: number } = {},
  ) {
    this.miner = new SkillPatternMiner(db);
    this.similarityThreshold = options.similarityThreshold ?? 0.75;
    this.embeddingDimension = options.embeddingDimension ?? 64;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contrastive_patterns (
        id TEXT PRIMARY KEY,
        pattern_id TEXT NOT NULL,
        embedding_json TEXT NOT NULL,
        cluster_id TEXT,
        similarity_score REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pattern_clusters (
        id TEXT PRIMARY KEY,
        centroid_json TEXT NOT NULL,
        coherence REAL NOT NULL DEFAULT 0,
        member_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  mineWithContrast(episode: SwarmEpisode): ContrastivePattern[] {
    const basePatterns = this.miner.mineFromEpisode(episode);
    const contrastive: ContrastivePattern[] = [];

    for (const pattern of basePatterns) {
      const embedding = this.embed(pattern.description + ' ' + pattern.steps.join(' '));
      const existingPatterns = this.getEmbeddingsForDomain(pattern.domains);
      let bestSimilarity = 0;
      let bestClusterId: string | null = null;

      for (const existing of existingPatterns) {
        const sim = this.cosineSimilarity(embedding, existing.embedding);
        if (sim > bestSimilarity && sim >= this.similarityThreshold) {
          bestSimilarity = sim;
          bestClusterId = existing.clusterId;
        }
      }

      const contrastivePattern: ContrastivePattern = {
        ...pattern,
        embedding,
        clusterId: bestClusterId,
        similarityScore: bestSimilarity,
      };

      this.persistEmbedding(contrastivePattern);
      contrastive.push(contrastivePattern);

      if (bestClusterId && bestSimilarity >= this.similarityThreshold) {
        this.mergeToCluster(bestClusterId, contrastivePattern);
      } else {
        this.createCluster(contrastivePattern);
      }
    }

    return contrastive;
  }

  findSimilarPatterns(query: string, limit: number = 10): ContrastivePattern[] {
    const queryEmbedding = this.embed(query);
    const allEmbeddings = this.getAllEmbeddings();

    const scored = allEmbeddings.map(ep => ({
      ...ep,
      similarityScore: this.cosineSimilarity(queryEmbedding, ep.embedding),
    }));

    scored.sort((a, b) => b.similarityScore - a.similarityScore);
    return scored.slice(0, limit);
  }

  getClusters(): ClusterResult[] {
    const clusters = this.db.prepare('SELECT * FROM pattern_clusters ORDER BY member_count DESC').all() as Array<{
      id: string; centroid_json: string; coherence: number; member_count: number;
    }>;

    return clusters.map(c => {
      const members = this.db.prepare('SELECT * FROM contrastive_patterns WHERE cluster_id = ?').all(c.id) as Array<{
        id: string; pattern_id: string; embedding_json: string; similarity_score: number;
      }>;

      return {
        clusterId: c.id,
        patterns: members.map(m => ({
          id: m.pattern_id,
          name: '',
          description: '',
          steps: [],
          evidence: 0,
          domains: [],
          successRate: 0,
          createdAt: '',
          embedding: JSON.parse(m.embedding_json) as number[],
          clusterId: c.id,
          similarityScore: m.similarity_score,
        })),
        centroid: JSON.parse(c.centroid_json) as number[],
        coherence: c.coherence,
      };
    });
  }

  deduplicatePatterns(): { merged: number; removed: number } {
    const clusters = this.getClusters();
    let merged = 0;
    let removed = 0;

    for (const cluster of clusters) {
      if (cluster.patterns.length < 2) continue;

      cluster.patterns.sort((a, b) => b.similarityScore - a.similarityScore);
      const representative = cluster.patterns[0];

      for (let i = 1; i < cluster.patterns.length; i++) {
        const duplicate = cluster.patterns[i];
        try {
          this.db.prepare('DELETE FROM skill_patterns WHERE id = ?').run(duplicate.id);
          this.db.prepare('UPDATE contrastive_patterns SET cluster_id = ? WHERE pattern_id = ?').run(representative.clusterId, duplicate.id);
          removed++;
        } catch { /* skip */ }
      }
      merged++;
    }

    return { merged, removed };
  }

  private embed(text: string): number[] {
    const embedding: number[] = new Array(this.embeddingDimension).fill(0);
    const words = text.toLowerCase().split(/\s+/);

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      let hash = 0;
      for (let j = 0; j < word.length; j++) {
        hash = ((hash << 5) - hash) + word.charCodeAt(j);
        hash |= 0;
      }
      const idx = Math.abs(hash) % this.embeddingDimension;
      embedding[idx] += 1 / words.length;

      if (i > 0) {
        const bigram = words[i - 1] + '_' + word;
        let bigramHash = 0;
        for (let j = 0; j < bigram.length; j++) {
          bigramHash = ((bigramHash << 5) - bigramHash) + bigram.charCodeAt(j);
          bigramHash |= 0;
        }
        const bigramIdx = Math.abs(bigramHash) % this.embeddingDimension;
        embedding[bigramIdx] += 0.5 / words.length;
      }
    }

    const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < embedding.length; i++) {
        embedding[i] /= norm;
      }
    }

    return embedding;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  private getEmbeddingsForDomain(domains: string[]): Array<{ embedding: number[]; clusterId: string | null }> {
    try {
      const rows = this.db.prepare(`
        SELECT cp.embedding_json, cp.cluster_id
        FROM contrastive_patterns cp
        JOIN skill_patterns sp ON cp.pattern_id = sp.id
        WHERE sp.domains_json LIKE ?
        ORDER BY cp.created_at DESC LIMIT 20
      `).all(`%${domains[0] || ''}%`) as Array<{ embedding_json: string; cluster_id: string | null }>;

      return rows.map(r => ({ embedding: JSON.parse(r.embedding_json) as number[], clusterId: r.cluster_id }));
    } catch { return []; }
  }

  private getAllEmbeddings(): ContrastivePattern[] {
    try {
      const rows = this.db.prepare('SELECT * FROM contrastive_patterns ORDER BY created_at DESC LIMIT 100').all() as Array<{
        id: string; pattern_id: string; embedding_json: string; cluster_id: string | null; similarity_score: number;
      }>;

      return rows.map(r => ({
        id: r.pattern_id, name: '', description: '', steps: [],
        evidence: 0, domains: [], successRate: 0, createdAt: '',
        embedding: JSON.parse(r.embedding_json) as number[],
        clusterId: r.cluster_id,
        similarityScore: r.similarity_score,
      }));
    } catch { return []; }
  }

  private persistEmbedding(pattern: ContrastivePattern): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO contrastive_patterns (id, pattern_id, embedding_json, cluster_id, similarity_score)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), pattern.id, JSON.stringify(pattern.embedding), pattern.clusterId, pattern.similarityScore);
  }

  private createCluster(pattern: ContrastivePattern): void {
    const clusterId = randomUUID();
    this.db.prepare(`
      INSERT INTO pattern_clusters (id, centroid_json, coherence, member_count)
      VALUES (?, ?, ?, 1)
    `).run(clusterId, JSON.stringify(pattern.embedding), pattern.similarityScore);

    this.db.prepare('UPDATE contrastive_patterns SET cluster_id = ? WHERE pattern_id = ?').run(clusterId, pattern.id);
    pattern.clusterId = clusterId;
  }

  private mergeToCluster(clusterId: string, pattern: ContrastivePattern): void {
    const cluster = this.db.prepare('SELECT * FROM pattern_clusters WHERE id = ?').get(clusterId) as {
      centroid_json: string; member_count: number; coherence: number;
    } | undefined;

    if (!cluster) return;

    const centroid = JSON.parse(cluster.centroid_json) as number[];
    const newCount = cluster.member_count + 1;

    for (let i = 0; i < centroid.length; i++) {
      centroid[i] = (centroid[i] * cluster.member_count + pattern.embedding[i]) / newCount;
    }

    const norm = Math.sqrt(centroid.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < centroid.length; i++) {
        centroid[i] /= norm;
      }
    }

    this.db.prepare("UPDATE pattern_clusters SET centroid_json = ?, member_count = ?, coherence = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(centroid), newCount, (cluster.coherence * cluster.member_count + pattern.similarityScore) / newCount, clusterId);

    this.db.prepare('UPDATE contrastive_patterns SET cluster_id = ? WHERE pattern_id = ?').run(clusterId, pattern.id);
    pattern.clusterId = clusterId;
  }
}
