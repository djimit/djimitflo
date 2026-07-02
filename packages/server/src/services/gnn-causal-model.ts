import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface GraphNode {
  id: string; features: number[]; nodeType: 'agent' | 'action' | 'outcome' | 'context'; label: string;
}

export interface GraphEdge {
  id: string; from: string; to: string; relation: string; weight: number;
}

export interface CausalPrediction {
  intervention: string; predictedOutcome: number; confidence: number; path: string[];
}

export class GNNCausalModel {
  private hidden: number;
  private layers: number;

  constructor(private db: Database, options: { hidden?: number; layers?: number } = {}) {
    this.hidden = options.hidden ?? 32;
    this.layers = options.layers ?? 2;
    db.exec("CREATE TABLE IF NOT EXISTS gnn_nodes (id TEXT PRIMARY KEY, features_json TEXT NOT NULL, node_type TEXT NOT NULL, label TEXT NOT NULL, embedding_json TEXT, created_at TEXT DEFAULT (datetime('now')))");
    db.exec("CREATE TABLE IF NOT EXISTS gnn_edges (id TEXT PRIMARY KEY, from_node TEXT NOT NULL, to_node TEXT NOT NULL, relation TEXT NOT NULL, weight REAL DEFAULT 1.0, created_at TEXT DEFAULT (datetime('now')))");
    db.exec('CREATE INDEX IF NOT EXISTS idx_gnn_edges_from ON gnn_edges(from_node)');
  }

  addNode(node: GraphNode): void {
    const emb = this.initEmb(node.features);
    this.db.prepare('INSERT OR REPLACE INTO gnn_nodes (id, features_json, node_type, label, embedding_json) VALUES (?, ?, ?, ?, ?)').run(node.id, JSON.stringify(node.features), node.nodeType, node.label, JSON.stringify(emb));
  }

  addEdge(edge: GraphEdge): void {
    this.db.prepare('INSERT OR REPLACE INTO gnn_edges (id, from_node, to_node, relation, weight) VALUES (?, ?, ?, ?, ?)').run(edge.id, edge.from, edge.to, edge.relation, edge.weight);
  }

  predict(interventionId: string): CausalPrediction {
    const reachable = this.getReachable(interventionId, this.layers);
    if (reachable.length === 0) return { intervention: interventionId, predictedOutcome: 0.5, confidence: 0.1, path: [] };
    const outcomes = reachable.filter(n => n.nodeType === 'outcome');
    let total = 0, weight = 0;
    const path: string[] = [];
    for (const o of outcomes) {
      const dist = this.distance(interventionId, o.id);
      const w = 1 / (1 + dist);
      total += o.features[0] * w;
      weight += w;
      path.push(o.label);
    }
    return { intervention: interventionId, predictedOutcome: weight > 0 ? total / weight : 0.5, confidence: Math.min(1, reachable.length / 10), path };
  }

  learn(features: Record<string, string>, outcome: number): void {
    const ctxId = randomUUID();
    const outId = randomUUID();
    const featVec = Object.values(features).map(v => this.hash(v));
    this.addNode({ id: ctxId, features: featVec, nodeType: 'context', label: Object.entries(features).map(([k, v]) => k + '=' + v).join(',') });
    this.addNode({ id: outId, features: [outcome], nodeType: 'outcome', label: 'outcome=' + outcome.toFixed(2) });
    this.addEdge({ id: randomUUID(), from: ctxId, to: outId, relation: 'causes', weight: outcome });
  }

  stats(): { nodes: number; edges: number; density: number } {
    const n = (this.db.prepare('SELECT COUNT(*) as c FROM gnn_nodes').get() as any).c;
    const e = (this.db.prepare('SELECT COUNT(*) as c FROM gnn_edges').get() as any).c;
    const max = n * (n - 1) / 2;
    return { nodes: n, edges: e, density: max > 0 ? e / max : 0 };
  }

  private initEmb(features: number[]): number[] {
    const emb = new Array(this.hidden).fill(0);
    for (let i = 0; i < Math.min(features.length, this.hidden); i++) emb[i] = features[i];
    const norm = Math.sqrt(emb.reduce((s, v) => s + v * v, 0));
    if (norm > 0) for (let i = 0; i < emb.length; i++) emb[i] /= norm;
    return emb;
  }

  private getReachable(startId: string, maxDepth: number): GraphNode[] {
    const visited = new Set<string>();
    const result: GraphNode[] = [];
    const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];
    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (visited.has(id) || depth > maxDepth) continue;
      visited.add(id);
      const node = this.db.prepare('SELECT * FROM gnn_nodes WHERE id = ?').get(id) as any;
      if (node) {
        result.push({ id: node.id, features: JSON.parse(node.features_json), nodeType: node.node_type, label: node.label });
        const edges = this.db.prepare('SELECT to_node FROM gnn_edges WHERE from_node = ?').all(id) as Array<{ to_node: string }>;
        for (const edge of edges) if (!visited.has(edge.to_node)) queue.push({ id: edge.to_node, depth: depth + 1 });
      }
    }
    return result;
  }

  private distance(from: string, to: string): number {
    const visited = new Set<string>();
    const queue: Array<{ id: string; dist: number }> = [{ id: from, dist: 0 }];
    while (queue.length > 0) {
      const { id, dist } = queue.shift()!;
      if (id === to) return dist;
      if (visited.has(id)) continue;
      visited.add(id);
      const edges = this.db.prepare('SELECT to_node FROM gnn_edges WHERE from_node = ?').all(id) as Array<{ to_node: string }>;
      for (const edge of edges) if (!visited.has(edge.to_node)) queue.push({ id: edge.to_node, dist: dist + 1 });
    }
    return Infinity;
  }

  private hash(value: string): number {
    let h = 0;
    for (let i = 0; i < value.length; i++) { h = ((h << 5) - h) + value.charCodeAt(i); h |= 0; }
    return (h % 1000) / 1000;
  }
}
