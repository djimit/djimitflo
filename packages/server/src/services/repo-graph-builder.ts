/**
 * RepoGraphBuilder — adapter around code-review-graph for the explainer pipeline.
 *
 * Builds an incremental structural graph of a cloned repository and persists
 * communities, flows, hub/bridge nodes, surprising connections, and metrics
 * into repo_graph_snapshots.
 */

import { execFile } from 'child_process';
import { readdirSync } from 'fs';
import { join, extname, relative } from 'path';
import Database from 'better-sqlite3';
import type { RepoGraphSnapshot } from '@djimitflo/shared';

export interface GraphNode {
  id: string;
  name: string;
  file: string;
  kind: 'hub' | 'bridge' | 'normal';
  community?: string;
  total_degree?: number;
  betweenness?: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  surprising?: boolean;
}

export interface GraphCommunity {
  id: string;
  name: string;
  size: number;
  cohesion: number;
  language: string;
}

export interface GraphFlow {
  id: string;
  name: string;
  criticality: number;
  depth: number;
  node_count: number;
}

export interface GraphMetrics {
  total_nodes: number;
  total_edges: number;
  total_files: number;
  risk_score: number | null;
}

export interface GraphSnapshotData {
  communities: GraphCommunity[];
  flows: GraphFlow[];
  hub_nodes: GraphNode[];
  bridge_nodes: GraphNode[];
  surprising_connections: GraphEdge[];
  metrics: GraphMetrics;
}

export interface BuildGraphOptions {
  repositoryId: string;
  scanId?: string | null;
  commitSha?: string | null;
  useRealGraph?: boolean;
}

export class RepoGraphBuilder {
  constructor(private db: Database.Database) {}

  private generateId(): string {
    return `graph-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private listSourceFiles(repoPath: string): string[] {
    const files: string[] = [];
    const extensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java']);
    const skip = new Set(['node_modules', '.git', 'dist', 'build', '.swarm', '.data']);

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && extensions.has(extname(entry.name))) {
          files.push(relative(repoPath, full));
        }
      }
    };

    walk(repoPath);
    return files;
  }

  private buildSyntheticGraph(repoPath: string): GraphSnapshotData {
    const files = this.listSourceFiles(repoPath);
    const fileCount = files.length;

    const nodes: GraphNode[] = files.slice(0, 12).map((file, i) => ({
      id: `node-${i}`,
      name: file,
      file,
      kind: i < 2 ? 'hub' : i < 4 ? 'bridge' : 'normal',
      community: `community-${i % 3}`,
      total_degree: Math.max(1, 6 - i),
      betweenness: i < 4 ? 0.5 - i * 0.05 : undefined,
    }));

    const communities: GraphCommunity[] = [
      { id: 'community-0', name: 'Core', size: Math.max(1, Math.floor(fileCount / 3)), cohesion: 0.85, language: 'typescript' },
      { id: 'community-1', name: 'Services', size: Math.max(1, Math.floor(fileCount / 3)), cohesion: 0.72, language: 'typescript' },
      { id: 'community-2', name: 'Tests', size: Math.max(1, fileCount - 2 * Math.floor(fileCount / 3)), cohesion: 0.68, language: 'typescript' },
    ];

    const edges: GraphEdge[] = [];
    for (let i = 0; i < nodes.length - 1; i++) {
      edges.push({ from: nodes[i].id, to: nodes[i + 1].id, surprising: i === 3 });
    }

    return {
      communities,
      flows: [{ id: 'flow-1', name: 'main-flow', criticality: 0.8, depth: 3, node_count: nodes.length }],
      hub_nodes: nodes.filter((n) => n.kind === 'hub'),
      bridge_nodes: nodes.filter((n) => n.kind === 'bridge'),
      surprising_connections: edges.filter((e) => e.surprising),
      metrics: {
        total_nodes: nodes.length,
        total_edges: edges.length,
        total_files: fileCount,
        risk_score: null,
      },
    };
  }

  private async tryBuildRealGraph(repoPath: string): Promise<GraphSnapshotData | null> {
    return new Promise((resolve) => {
      execFile(
        'npx',
        ['code-review-graph', 'build', '--repo_root', repoPath, '--postprocess', 'minimal'],
        { timeout: 120_000 },
        (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          try {
            const parsed = JSON.parse(stdout) as GraphSnapshotData;
            resolve(parsed);
          } catch {
            resolve(null);
          }
        },
      );
    });
  }

  async buildGraph(repoPath: string, options: BuildGraphOptions = { repositoryId: '' }): Promise<RepoGraphSnapshot> {
    const data = options.useRealGraph ? await this.tryBuildRealGraph(repoPath) : null;
    const graph = data ?? this.buildSyntheticGraph(repoPath);

    const id = this.generateId();
    const now = new Date().toISOString();

    const snapshot: RepoGraphSnapshot = {
      id,
      repository_id: options.repositoryId,
      scan_id: options.scanId ?? null,
      commit_sha: options.commitSha ?? null,
      communities: graph.communities,
      flows: graph.flows,
      hub_nodes: graph.hub_nodes,
      bridge_nodes: graph.bridge_nodes,
      surprising_connections: graph.surprising_connections,
      metrics: graph.metrics as unknown as Record<string, unknown>,
      metadata: { source: data ? 'code-review-graph' : 'synthetic', file_count: graph.metrics.total_files },
      created_at: now,
      updated_at: now,
    };

    const insert = this.db.prepare(`
      INSERT INTO repo_graph_snapshots (
        id, repository_id, scan_id, commit_sha,
        communities_json, flows_json, hub_nodes_json, bridge_nodes_json,
        surprising_connections_json, metrics_json, metadata,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insert.run(
      snapshot.id,
      snapshot.repository_id,
      snapshot.scan_id,
      snapshot.commit_sha,
      JSON.stringify(snapshot.communities),
      JSON.stringify(snapshot.flows),
      JSON.stringify(snapshot.hub_nodes),
      JSON.stringify(snapshot.bridge_nodes),
      JSON.stringify(snapshot.surprising_connections),
      JSON.stringify(snapshot.metrics),
      JSON.stringify(snapshot.metadata),
      snapshot.created_at,
      snapshot.updated_at,
    );

    return snapshot;
  }

  getLatestSnapshot(repositoryId: string): RepoGraphSnapshot | undefined {
    const row = this.db
      .prepare('SELECT * FROM repo_graph_snapshots WHERE repository_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(repositoryId) as Record<string, unknown> | undefined;

    if (!row) return undefined;

    return {
      id: String(row.id),
      repository_id: String(row.repository_id),
      scan_id: row.scan_id ? String(row.scan_id) : null,
      commit_sha: row.commit_sha ? String(row.commit_sha) : null,
      communities: JSON.parse(String(row.communities_json)),
      flows: JSON.parse(String(row.flows_json)),
      hub_nodes: JSON.parse(String(row.hub_nodes_json)),
      bridge_nodes: JSON.parse(String(row.bridge_nodes_json)),
      surprising_connections: JSON.parse(String(row.surprising_connections_json)),
      metrics: JSON.parse(String(row.metrics_json)),
      metadata: JSON.parse(String(row.metadata)),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }
}
