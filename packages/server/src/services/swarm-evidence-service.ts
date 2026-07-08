/**
 * SwarmEvidenceService — evidence edges, lineage resolution, graph traversal.
 *
 * Extracted from SwarmIntelligenceService (~120 LOC) to isolate the evidence
 * graph logic from the rest of the swarm intelligence system.
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export class SwarmEvidenceService {
  constructor(private db: Database) {
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS swarm_evidence_edges (
        id TEXT PRIMARY KEY,
        from_ref TEXT NOT NULL,
        to_ref TEXT NOT NULL,
        relation TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  /**
   * Create an evidence edge between two refs.
   */
  createEvidenceEdge(fromRef: string, toRef: string, relation: string, metadata: Record<string, unknown> = {}) {
    if (!fromRef.trim() || !toRef.trim() || !relation.trim()) throw new Error('SWARM_EVIDENCE_EDGE_INVALID');
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO swarm_evidence_edges (id, from_ref, to_ref, relation, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, fromRef.trim(), toRef.trim(), relation.trim(), JSON.stringify(metadata), new Date().toISOString());
    return { id, from_ref: fromRef.trim(), to_ref: toRef.trim(), relation: relation.trim(), metadata };
  }

  /**
   * Forward lineage traversal — follow edges from ref.
   */
  lineageForward(ref: string, maxDepth = 10): { ref: string; edges: Array<{ to: string; relation: string; depth: number }> } {
    const visited = new Set<string>([ref]);
    const edges: Array<{ to: string; relation: string; depth: number }> = [];
    const queue: Array<{ ref: string; depth: number }> = [{ ref, depth: 0 }];
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.depth >= maxDepth) continue;
      const rows = this.db.prepare('SELECT to_ref, relation FROM swarm_evidence_edges WHERE from_ref = ?').all(item.ref) as any[];
      for (const row of rows) {
        if (visited.has(row.to_ref)) continue;
        visited.add(row.to_ref);
        edges.push({ to: row.to_ref, relation: row.relation, depth: item.depth + 1 });
        queue.push({ ref: row.to_ref, depth: item.depth + 1 });
      }
    }
    return { ref, edges };
  }

  /**
   * Reverse lineage traversal — follow edges to ref.
   */
  lineageReverse(ref: string, maxDepth = 10): { ref: string; edges: Array<{ from: string; relation: string; depth: number }> } {
    const visited = new Set<string>([ref]);
    const edges: Array<{ from: string; relation: string; depth: number }> = [];
    const queue: Array<{ ref: string; depth: number }> = [{ ref, depth: 0 }];
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.depth >= maxDepth) continue;
      const rows = this.db.prepare('SELECT from_ref, relation FROM swarm_evidence_edges WHERE to_ref = ?').all(item.ref) as any[];
      for (const row of rows) {
        if (visited.has(row.from_ref)) continue;
        visited.add(row.from_ref);
        edges.push({ from: row.from_ref, relation: row.relation, depth: item.depth + 1 });
        queue.push({ ref: row.from_ref, depth: item.depth + 1 });
      }
    }
    return { ref, edges };
  }

  /**
   * Graph summary — forward and reverse edges from/to ref.
   */
  evidenceGraphSummary(ref: string): { ref: string; forward_count: number; reverse_count: number; forward: Array<{ to: string; relation: string }>; reverse: Array<{ from: string; relation: string }> } {
    const fwd = this.db.prepare('SELECT to_ref, relation FROM swarm_evidence_edges WHERE from_ref = ?').all(ref) as any[];
    const rev = this.db.prepare('SELECT from_ref, relation FROM swarm_evidence_edges WHERE to_ref = ?').all(ref) as any[];
    return {
      ref,
      forward_count: fwd.length,
      reverse_count: rev.length,
      forward: fwd.map((r) => ({ to: r.to_ref, relation: r.relation })),
      reverse: rev.map((r) => ({ from: r.from_ref, relation: r.relation })),
    };
  }

  /**
   * Permission-scoped forward traversal.
   */
  lineageForwardScoped(ref: string, permittedRefs: Set<string>, maxDepth = 10): { ref: string; edges: Array<{ to: string; relation: string; depth: number }> } {
    const full = this.lineageForward(ref, maxDepth);
    return { ref, edges: full.edges.filter((e) => permittedRefs.has(e.to) || permittedRefs.has('*')) };
  }

  /**
   * Permission-scoped reverse traversal.
   */
  lineageReverseScoped(ref: string, permittedRefs: Set<string>, maxDepth = 10): { ref: string; edges: Array<{ from: string; relation: string; depth: number }> } {
    const full = this.lineageReverse(ref, maxDepth);
    return { ref, edges: full.edges.filter((e) => permittedRefs.has(e.from) || permittedRefs.has('*')) };
  }

  /**
   * Resolve evidence refs — verify they exist in the database.
   */
  resolveEvidenceRefs(refs: string[]): { all_resolved: boolean; unresolved: string[] } {
    const unresolved: string[] = [];
    for (const ref of refs) {
      const [kind, id] = ref.split(':');
      if (!kind || !id) { unresolved.push(ref); continue; }
      let exists = false;
      try {
        switch (kind) {
          case 'claim': exists = !!(this.db.prepare('SELECT 1 FROM swarm_claims WHERE id = ?').get(id)); break;
          case 'capability': exists = !!(this.db.prepare('SELECT 1 FROM swarm_capabilities WHERE id = ?').get(id)); break;
          case 'manifest': exists = !!(this.db.prepare('SELECT 1 FROM swarm_runner_manifests WHERE id = ?').get(id)); break;
          case 'memory': exists = !!(this.db.prepare('SELECT 1 FROM memory_candidates WHERE id = ?').get(id)); break;
          case 'panel': exists = !!(this.db.prepare('SELECT 1 FROM specialist_panels WHERE id = ?').get(id)); break;
          case 'goal': exists = !!(this.db.prepare('SELECT 1 FROM goals WHERE id = ?').get(id)); break;
          case 'loop': exists = !!(this.db.prepare('SELECT 1 FROM loop_runs WHERE id = ?').get(id)); break;
          case 'lease': exists = !!(this.db.prepare('SELECT 1 FROM worker_leases WHERE id = ?').get(id)); break;
          case 'mission': exists = !!(this.db.prepare('SELECT 1 FROM swarm_missions WHERE id = ?').get(id)); break;
          case 'task': exists = !!(this.db.prepare('SELECT 1 FROM swarm_tasks WHERE id = ?').get(id)); break;
          default: exists = true;
        }
      } catch { exists = false; }
      if (!exists) unresolved.push(ref);
    }
    return { all_resolved: unresolved.length === 0, unresolved };
  }

  /**
   * Extract claims from a specialist panel.
   */
  extractClaimsFromPanel(panelId: string): { extracted: number; claims: Array<{ id: string; claim: string; status: string }> } {
    try {
      const rows = this.db.prepare('SELECT id, claim, status FROM swarm_claims WHERE metadata LIKE ?').all(`%${panelId}%`) as any[];
      return { extracted: rows.length, claims: rows.map((r) => ({ id: r.id, claim: r.claim, status: r.status })) };
    } catch {
      return { extracted: 0, claims: [] };
    }
  }
}
