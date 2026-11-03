import type { Database } from 'better-sqlite3';
import { cosineSimilarity, type EmbeddingProvider } from './embedding-provider';

/**
 * Collapses near-duplicate parked self-improvement proposals into one representative each.
 *
 * Production (2026-09-20) held 710 parked proposals, mostly rewrites of the same vague ideas.
 * Non-representatives become status 'archived' with a unique fingerprint (so the boot-time
 * duplicate-fingerprint collapse in migrate.ts never deletes them); the original status and
 * fingerprint are kept in proposal_clusters so apply() is fully reversible via restore().
 */

export interface ClusterPlan {
  total: number;
  clusters: Array<{ clusterId: string; representativeId: string; memberIds: string[] }>;
  archiveCount: number;
  method: 'embedding' | 'jaccard';
  /** Why embeddings were not used (only set when method is 'jaccard' although an embedder was given). */
  fallbackReason?: string;
}

interface Row { id: string; title: string; description: string; priority: number; created_at: string; fingerprint: string | null }

const tokens = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2));

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

export class ProposalClusteringService {
  constructor(
    private readonly db: Database,
    private readonly opts: { embedder?: Pick<EmbeddingProvider, 'embed'>; threshold?: number; jaccardThreshold?: number } = {},
  ) {}

  async plan(): Promise<ClusterPlan> {
    const rows = this.db.prepare(`
      SELECT id, title, description, priority, created_at, fingerprint FROM self_improvements
      WHERE status = 'needs_more_evidence' ORDER BY priority DESC, created_at ASC
    `).all() as Row[];
    const texts = rows.map(r => `${r.title}\n${r.description}`);
    let similarity: (i: number, j: number) => number;
    let method: ClusterPlan['method'] = 'jaccard';
    let fallbackReason: string | undefined;
    let threshold = this.opts.jaccardThreshold ?? 0.6;
    try {
      if (this.opts.embedder && rows.length) {
        // Bounded concurrency: a single Promise.all over ~700 texts overwhelmed the Ollama host in production.
        const vectors = await this.embedAll(texts.map(t => t.slice(0, 1500)));
        similarity = (i, j) => cosineSimilarity(vectors[i], vectors[j]);
        method = 'embedding';
        threshold = this.opts.threshold ?? 0.88;
      } else throw new Error('no embedder');
    } catch (err) {
      if (this.opts.embedder) fallbackReason = err instanceof Error ? err.message : String(err);
      const sets = texts.map(tokens);
      similarity = (i, j) => jaccard(sets[i], sets[j]);
    }

    // Greedy: rows are ordered best-first, so the first unassigned row of a cluster is its representative.
    const assigned = new Set<number>();
    const clusters: ClusterPlan['clusters'] = [];
    for (let i = 0; i < rows.length; i++) {
      if (assigned.has(i)) continue;
      assigned.add(i);
      const members: number[] = [];
      for (let j = i + 1; j < rows.length; j++) {
        if (!assigned.has(j) && similarity(i, j) >= threshold) { assigned.add(j); members.push(j); }
      }
      if (members.length) clusters.push({ clusterId: `cluster:${rows[i].id}`, representativeId: rows[i].id, memberIds: members.map(j => rows[j].id) });
    }
    return { total: rows.length, clusters, archiveCount: clusters.reduce((n, c) => n + c.memberIds.length, 0), method, ...(fallbackReason ? { fallbackReason } : {}) };
  }

  private async embedAll(texts: string[], concurrency = 6): Promise<number[][]> {
    const vectors: number[][] = new Array(texts.length);
    let next = 0;
    const worker = async () => {
      while (next < texts.length) {
        const i = next++;
        vectors[i] = await this.opts.embedder!.embed(texts[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, texts.length) }, worker));
    return vectors;
  }

  /** Archives non-representatives. Reversible: originals are recorded in proposal_clusters. */
  apply(plan: ClusterPlan): number {
    const now = new Date().toISOString();
    const original = this.db.prepare('SELECT status, fingerprint, panel_id FROM self_improvements WHERE id = ? AND status = ?');
    const record = this.db.prepare('INSERT OR REPLACE INTO proposal_clusters (improvement_id, cluster_id, representative_id, original_status, original_fingerprint, archived_at) VALUES (?, ?, ?, ?, ?, ?)');
    const archive = this.db.prepare("UPDATE self_improvements SET status = 'archived', fingerprint = ?, updated_at = ? WHERE id = ?");
    const cancelPanel = this.db.prepare("UPDATE specialist_panels SET status = 'cancelled', updated_at = ? WHERE id = ? AND status NOT IN ('goal_created', 'backlog_created')");
    let archived = 0;
    this.db.transaction(() => {
      for (const cluster of plan.clusters) {
        for (const id of cluster.memberIds) {
          const row = original.get(id, 'needs_more_evidence') as { status: string; fingerprint: string | null; panel_id: string | null } | undefined;
          if (!row) continue; // changed since planning: leave it alone
          record.run(id, cluster.clusterId, cluster.representativeId, row.status, row.fingerprint, now);
          archive.run(`archived:${id}`, now, id);
          if (row.panel_id) cancelPanel.run(now, row.panel_id);
          archived++;
        }
      }
    })();
    return archived;
  }

  /** Undo apply(): restores status and fingerprint of every archived member. */
  restore(): number {
    const rows = this.db.prepare('SELECT improvement_id, original_status, original_fingerprint FROM proposal_clusters').all() as Array<{ improvement_id: string; original_status: string; original_fingerprint: string | null }>;
    const now = new Date().toISOString();
    let restored = 0;
    this.db.transaction(() => {
      for (const r of rows) {
        const res = this.db.prepare("UPDATE self_improvements SET status = ?, fingerprint = ?, updated_at = ? WHERE id = ? AND status = 'archived'").run(r.original_status, r.original_fingerprint, now, r.improvement_id);
        restored += res.changes;
      }
      this.db.exec('DELETE FROM proposal_clusters');
    })();
    return restored;
  }
}
