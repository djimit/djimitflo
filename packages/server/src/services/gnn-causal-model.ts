import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface GraphNode {
  id: string;
  features: number[];
  nodeType: 'agent' | 'action' | 'outcome' | 'context';
  label: string;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  relation: string;
  weight: number;
}

export interface CausalPrediction {
  intervention: string;
  predictedOutcome: number;
  confidence: number;
  path: string[];
}

export class GNNCausalModel {
  private hiddenDim: number;
  private numLayers: number;
  private attentionHeads: number;

  constructor(
    private db: Database,
    options: { hiddenDim?: number; numLayers?: number; attentionHeads?: number } = {},
  ) {
    this.hiddenDim = options.hiddenDim ?? 32;
    this.numLayers = options.numLayers ?? 2;
    this.attentionHeads = options.attentionHeads ?? 2;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gnn_nodes (
        id TEXT PRIMARY KEY,
        features_json TEXT NOT NULL,
        node_type TEXT NOT NULL,
        label TEXT NOT NULL,
        embedding_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gnn_edges (
        id TEXT PRIMARY KEY,
        from_node TEXT NOT NULL,
        to_node TEXT NOT NULL,
        relation TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_gnn_edges_from ON gnn_edges(from_node)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_gnn_edges_to ON gnn_edges(to_node)');
  }

  addNode(node: GraphNode): void {
    const embedding = this.initEmbedding(node.features);
    this.db.prepare(`
      INSERT OR REPLACE INTO gnn_nodes (id, features_json, node_type, label, embedding_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(node.id, JSON.stringify(node.features), node.nodeType, node.label, JSON.stringify(embedding));
  }

  addEdge(edge: GraphEdge): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO gnn_edges (id, from_node, to_node, relation, weight)
      VALUES (?, ?, ?, ?, ?)
    `).run(edge.id, edge.from, edge.to, edge.relation, edge.weight);
  }

  predictIntervention(interventionNodeId: string): CausalPrediction {
    const reachable = this.getReachableNodes(interventionNodeId, this.numLayers);
    if (reachable.length === 0) {
      return { intervention: interventionNodeId, predictedOutcome: 0.5, confidence: 0.1, path: [] };
    }

    const nodeMap = new Map<string, number[]>();
    for (const n of reachable) nodeMap.set(n.id, n.features);
    const embeddings = this.propagate(nodeMap);
    const outcomeNodes = reachable.filter(n => n.nodeType === 'outcome');

    let totalOutcome = 0;
    let totalWeight = 0;
    const path: string[] = [];

    for (const outcome of outcomeNodes) {
      const embedding = embeddings.get(outcome.id);
      if (!embedding) continue;

      const score = this.aggregateAttention(embedding);
      const distance = this.getDistance(interventionNodeId, outcome.id);
      const weight = 1 / (1 + distance);

      totalOutcome += score * weight;
      totalWeight += weight;
      path.push(outcome.label);
    }

    const predictedOutcome = totalWeight > 0 ? totalOutcome / totalWeight : 0.5;
    const confidence = Math.min(1, reachable.length / 10);

    return { intervention: interventionNodeId, predictedOutcome, confidence, path };
  }

  learnFromObservation(features: Record<string, string>, outcome: number): void {
    const featureVec = Object.values(features).map(v => this.hashFeature(v));
    const nodeId = randomUUID();

    this.addNode({
      id: nodeId,
      features: featureVec,
      nodeType: 'context',
      label: Object.entries(features).map(([k, v]) => `${k}=${v}`).join(','),
    });

    const outcomeNodeId = randomUUID();
    this.addNode({
      id: outcomeNodeId,
      features: [outcome],
      nodeType: 'outcome',
      label: `outcome=${outcome.toFixed(2)}`,
    });

    this.addEdge({
      id: randomUUID(),
      from: nodeId,
      to: outcomeNodeId,
      relation: 'causes',
      weight: outcome,
    });
  }

  getGraphStats(): { nodes: number; edges: number; density: number } {
    const nodes = this.db.prepare('SELECT COUNT(*) as c FROM gnn_nodes').get() as { c: number };
    const edges = this.db.prepare('SELECT COUNT(*) as c FROM gnn_edges').get() as { c: number };
    const n = nodes.c;
    const maxEdges = n * (n - 1) / 2;

    return {
      nodes: nodes.c,
      edges: edges.c,
      density: maxEdges > 0 ? edges.c / maxEdges : 0,
    };
  }

  private initEmbedding(features: number[]): number[] {
    const embedding: number[] = new Array(this.hiddenDim).fill(0);
    for (let i = 0; i < Math.min(features.length, this.hiddenDim); i++) {
      embedding[i] = features[i];
    }
    const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < embedding.length; i++) {
        embedding[i] /= norm;
      }
    }
    return embedding;
  }

  private getReachableNodes(startId: string, maxDepth: number): GraphNode[] {
    const visited = new Set<string>();
    const result: GraphNode[] = [];
    const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (visited.has(id) || depth > maxDepth) continue;
      visited.add(id);

      const node = this.db.prepare('SELECT * FROM gnn_nodes WHERE id = ?').get(id) as {
        id: string; features_json: string; node_type: string; label: string;
      } | undefined;

      if (node) {
        result.push({
          id: node.id,
          features: JSON.parse(node.features_json) as number[],
          nodeType: node.node_type as GraphNode['nodeType'],
          label: node.label,
        });

        const edges = this.db.prepare('SELECT to_node FROM gnn_edges WHERE from_node = ?').all(id) as Array<{ to_node: string }>;
        for (const edge of edges) {
          if (!visited.has(edge.to_node)) {
            queue.push({ id: edge.to_node, depth: depth + 1 });
          }
        }
      }
    }

    return result;
  }

  private propagate(nodes: Map<string, number[]>): Map<string, number[]> {
    const updated = new Map<string, number[]>();

    for (const [id, embedding] of nodes) {
      const neighbors = this.db.prepare(`
        SELECT n.embedding_json, e.weight FROM gnn_edges e
        JOIN gnn_nodes n ON e.from_node = n.id
        WHERE e.to_node = ?
      `).all(id) as Array<{ embedding_json: string; weight: number }>;

      const newEmbedding = [...embedding];

      for (const neighbor of neighbors) {
        const neighborEmb = JSON.parse(neighbor.embedding_json) as number[];
        for (let i = 0; i < Math.min(newEmbedding.length, neighborEmb.length); i++) {
          newEmbedding[i] += neighbor.weight * neighborEmb[i] * 0.1;
        }
      }

      const norm = Math.sqrt(newEmbedding.reduce((sum, v) => sum + v * v, 0));
      if (norm > 0) {
        for (let i = 0; i < newEmbedding.length; i++) {
          newEmbedding[i] /= norm;
        }
      }

      updated.set(id, newEmbedding);
    }

    return updated;
  }

  private aggregateAttention(embedding: number[]): number {
    let sum = 0;
    for (let h = 0; h < this.attentionHeads; h++) {
      let headSum = 0;
      for (let i = h; i < embedding.length; i += this.attentionHeads) {
        headSum += embedding[i];
      }
      sum += headSum / Math.ceil(embedding.length / this.attentionHeads);
    }
    return 1 / (1 + Math.exp(-sum / this.attentionHeads));
  }

  private getDistance(fromId: string, toId: string): number {
    const visited = new Set<string>();
    const queue: Array<{ id: string; dist: number }> = [{ id: fromId, dist: 0 }];

    while (queue.length > 0) {
      const { id, dist } = queue.shift()!;
      if (id === toId) return dist;
      if (visited.has(id)) continue;
      visited.add(id);

      const edges = this.db.prepare('SELECT to_node FROM gnn_edges WHERE from_node = ?').all(id) as Array<{ to_node: string }>;
      for (const edge of edges) {
        if (!visited.has(edge.to_node)) {
          queue.push({ id: edge.to_node, dist: dist + 1 });
        }
      }
    }

    return Infinity;
  }

  private hashFeature(value: string): number {
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
      hash = ((hash << 5) - hash) + value.charCodeAt(i);
      hash |= 0;
    }
    return (hash % 1000) / 1000;
  }
}
