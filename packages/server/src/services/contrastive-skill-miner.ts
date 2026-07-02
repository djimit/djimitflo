import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { SkillPatternMiner, type SkillPattern, type SwarmEpisode } from './skill-pattern-miner';

export interface ContrastivePattern extends SkillPattern {
  embedding: number[];
  clusterId: string | null;
  similarityScore: number;
}

export class ContrastiveSkillMiner {
  private miner: SkillPatternMiner;
  private dim: number;

  constructor(private db: Database, options: { dim?: number } = {}) {
    this.miner = new SkillPatternMiner(db);
    this.dim = options.dim ?? 64;
    db.exec("CREATE TABLE IF NOT EXISTS contrastive_patterns (id TEXT PRIMARY KEY, pattern_id TEXT NOT NULL, embedding_json TEXT NOT NULL, cluster_id TEXT, similarity_score REAL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))");
    db.exec("CREATE TABLE IF NOT EXISTS pattern_clusters (id TEXT PRIMARY KEY, centroid_json TEXT NOT NULL, coherence REAL DEFAULT 0, member_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))");
  }

  mineWithContrast(episode: SwarmEpisode): ContrastivePattern[] {
    const base = this.miner.mineFromEpisode(episode);
    return base.map(p => {
      const embedding = this.embed(p.description + ' ' + p.steps.join(' '));
      const result: ContrastivePattern = { ...p, embedding, clusterId: null, similarityScore: 0 };
      this.db.prepare('INSERT OR REPLACE INTO contrastive_patterns (id, pattern_id, embedding_json, cluster_id, similarity_score) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), p.id, JSON.stringify(embedding), null, 0);
      return result;
    });
  }

  findSimilar(query: string, limit: number = 10): ContrastivePattern[] {
    const qEmb = this.embed(query);
    const rows = this.db.prepare('SELECT * FROM contrastive_patterns LIMIT 100').all() as any[];
    const scored = rows.map(r => ({ id: r.pattern_id, name: '', description: '', steps: [], evidence: 0, domains: [], successRate: 0, createdAt: '', embedding: JSON.parse(r.embedding_json), clusterId: r.cluster_id, similarityScore: this.cosine(qEmb, JSON.parse(r.embedding_json)) }));
    scored.sort((a, b) => b.similarityScore - a.similarityScore);
    return scored.slice(0, limit);
  }

  getClusters(): any[] {
    return this.db.prepare('SELECT * FROM pattern_clusters ORDER BY member_count DESC').all();
  }

  deduplicate(): { merged: number; removed: number } {
    return { merged: 0, removed: 0 };
  }

  private embed(text: string): number[] {
    const emb = new Array(this.dim).fill(0);
    const words = text.toLowerCase().split(/\s+/);
    for (const word of words) {
      let hash = 0;
      for (let i = 0; i < word.length; i++) { hash = ((hash << 5) - hash) + word.charCodeAt(i); hash |= 0; }
      emb[Math.abs(hash) % this.dim] += 1 / words.length;
    }
    const norm = Math.sqrt(emb.reduce((s, v) => s + v * v, 0));
    if (norm > 0) for (let i = 0; i < emb.length; i++) emb[i] /= norm;
    return emb;
  }

  private cosine(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    const d = Math.sqrt(na) * Math.sqrt(nb);
    return d === 0 ? 0 : dot / d;
  }
}
