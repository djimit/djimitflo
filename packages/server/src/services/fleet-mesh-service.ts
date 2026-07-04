/**
 * FleetMeshService — cross-machine agent coordination via MCP federation.
 *
 * Connects multiple DjimFlo instances into a unified cognitive fabric:
 * 1. Node registry — track available fleet nodes (workstation, MacBook, Eve-V)
 * 2. Agent handoff — transfer agent work between machines
 * 3. Fleet governance — synchronized governance scoring across nodes
 * 4. Work distribution — distribute loop work to optimal nodes
 * 5. Capability sharing — share learned capabilities across the fleet
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

interface FleetNode {
  id: string;
  name: string;
  endpoint: string;
  status: 'online' | 'offline' | 'degraded';
  capabilities: string[];
  activeAgents: number;
  maxAgents: number;
  lastHeartbeat: string;
  metadata: Record<string, unknown>;
}

interface HandoffRequest {
  id: string;
  fromNode: string;
  toNode: string;
  agentId: string;
  leaseId: string;
  context: Record<string, unknown>;
  status: 'pending' | 'accepted' | 'rejected' | 'completed';
  createdAt: string;
}

interface WorkDistribution {
  id: string;
  loopRunId: string;
  assignedNode: string;
  reason: string;
  priority: number;
  status: 'assigned' | 'accepted' | 'in_progress' | 'completed';
}

interface CapabilitySync {
  id: string;
  sourceNode: string;
  capabilityId: string;
  capabilityType: string;
  score: number;
  syncedAt: string;
}

export class FleetMeshService {
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private db: Database) {
    this.ensureTables();
  }

  /**
   * Register a fleet node.
   */
  registerNode(input: {
    name: string;
    endpoint: string;
    capabilities?: string[];
    maxAgents?: number;
    metadata?: Record<string, unknown>;
  }): FleetNode {
    const existing = this.db.prepare('SELECT id FROM fleet_nodes WHERE endpoint = ?').get(input.endpoint) as any;

    if (existing) {
      this.db.prepare(`
        UPDATE fleet_nodes SET name = ?, capabilities_json = ?, max_agents = ?, last_heartbeat = ?, status = 'online'
        WHERE id = ?
      `).run(
        input.name,
        JSON.stringify(input.capabilities || []),
        input.maxAgents || 10,
        new Date().toISOString(),
        existing.id,
      );
      return this.getNode(existing.id)!;
    }

    const node: FleetNode = {
      id: randomUUID(),
      name: input.name,
      endpoint: input.endpoint,
      status: 'online',
      capabilities: input.capabilities || [],
      activeAgents: 0,
      maxAgents: input.maxAgents || 10,
      lastHeartbeat: new Date().toISOString(),
      metadata: input.metadata || {},
    };

    this.db.prepare(`
      INSERT INTO fleet_nodes (id, name, endpoint, status, capabilities_json, active_agents, max_agents, last_heartbeat, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      node.id, node.name, node.endpoint, node.status,
      JSON.stringify(node.capabilities), node.activeAgents,
      node.maxAgents, node.lastHeartbeat, JSON.stringify(node.metadata),
    );

    return node;
  }

  /**
   * Get a fleet node by ID.
   */
  getNode(id: string): FleetNode | null {
    const row = this.db.prepare('SELECT * FROM fleet_nodes WHERE id = ?').get(id) as any;
    if (!row) return null;
    return this.parseNode(row);
  }

  /**
   * List all fleet nodes.
   */
  listNodes(): FleetNode[] {
    return (this.db.prepare('SELECT * FROM fleet_nodes ORDER BY last_heartbeat DESC').all() as any[]).map((r) => this.parseNode(r));
  }

  /**
   * Find the best node for a new agent based on capacity and capabilities.
   */
  findBestNode(requiredCapabilities: string[] = []): FleetNode | null {
    const nodes = this.listNodes().filter((n) => n.status === 'online' && n.activeAgents < n.maxAgents);

    if (nodes.length === 0) return null;

    // Score nodes by: available capacity, capability match, recency
    const scored = nodes.map((node) => {
      const capacityScore = 1 - (node.activeAgents / node.maxAgents);
      const capabilityScore = requiredCapabilities.length > 0
        ? requiredCapabilities.filter((c) => node.capabilities.includes(c)).length / requiredCapabilities.length
        : 1;
      return { node, score: capacityScore * 0.6 + capabilityScore * 0.4 };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.node || null;
  }

  /**
   * Request an agent handoff between nodes.
   */
  requestHandoff(input: {
    fromNode: string;
    toNode: string;
    agentId: string;
    leaseId: string;
    context?: Record<string, unknown>;
  }): HandoffRequest {
    const handoff: HandoffRequest = {
      id: randomUUID(),
      fromNode: input.fromNode,
      toNode: input.toNode,
      agentId: input.agentId,
      leaseId: input.leaseId,
      context: input.context || {},
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT INTO fleet_handoffs (id, from_node, to_node, agent_id, lease_id, context_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      handoff.id, handoff.fromNode, handoff.toNode, handoff.agentId,
      handoff.leaseId, JSON.stringify(handoff.context), handoff.status, handoff.createdAt,
    );

    return handoff;
  }

  /**
   * Accept a handoff request.
   */
  acceptHandoff(handoffId: string): void {
    this.db.prepare("UPDATE fleet_handoffs SET status = 'accepted' WHERE id = ?").run(handoffId);
  }

  /**
   * Complete a handoff.
   */
  completeHandoff(handoffId: string): void {
    this.db.prepare("UPDATE fleet_handoffs SET status = 'completed' WHERE id = ?").run(handoffId);
  }

  /**
   * Distribute work to the optimal node.
   */
  distributeWork(input: {
    loopRunId: string;
    requiredCapabilities?: string[];
    priority?: number;
  }): WorkDistribution | null {
    const bestNode = this.findBestNode(input.requiredCapabilities || []);
    if (!bestNode) return null;

    const distribution: WorkDistribution = {
      id: randomUUID(),
      loopRunId: input.loopRunId,
      assignedNode: bestNode.id,
      reason: `Selected node "${bestNode.name}" (capacity: ${bestNode.activeAgents}/${bestNode.maxAgents})`,
      priority: input.priority || 5,
      status: 'assigned',
    };

    this.db.prepare(`
      INSERT INTO fleet_work_distribution (id, loop_run_id, assigned_node, reason, priority, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      distribution.id, distribution.loopRunId, distribution.assignedNode,
      distribution.reason, distribution.priority, distribution.status,
    );

    return distribution;
  }

  /**
   * Sync a capability from another node.
   */
  syncCapability(input: {
    sourceNode: string;
    capabilityId: string;
    capabilityType: string;
    score: number;
  }): CapabilitySync {
    const sync: CapabilitySync = {
      id: randomUUID(),
      sourceNode: input.sourceNode,
      capabilityId: input.capabilityId,
      capabilityType: input.capabilityType,
      score: input.score,
      syncedAt: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT INTO fleet_capability_sync (id, source_node, capability_id, capability_type, score, synced_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      sync.id, sync.sourceNode, sync.capabilityId,
      sync.capabilityType, sync.score, sync.syncedAt,
    );

    return sync;
  }

  /**
   * Start heartbeat monitoring of fleet nodes.
   */
  startHeartbeat(intervalMs = 30000): void {
    if (this.heartbeatInterval) return;

    this.heartbeatInterval = setInterval(() => {
      const staleThreshold = new Date(Date.now() - intervalMs * 3).toISOString();
      this.db.prepare(`
        UPDATE fleet_nodes SET status = 'offline' WHERE last_heartbeat < ? AND status = 'online'
      `).run(staleThreshold);
    }, intervalMs);
  }

  /**
   * Stop heartbeat monitoring.
   */
  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Get fleet status summary.
   */
  getStatus(): {
    totalNodes: number;
    onlineNodes: number;
    offlineNodes: number;
    totalCapacity: number;
    activeAgents: number;
    pendingHandoffs: number;
  } {
    const nodes = this.listNodes();
    const online = nodes.filter((n) => n.status === 'online').length;
    const totalCapacity = nodes.reduce((sum, n) => sum + n.maxAgents, 0);
    const activeAgents = nodes.reduce((sum, n) => sum + n.activeAgents, 0);
    const pendingHandoffs = (this.db.prepare("SELECT COUNT(*) as c FROM fleet_handoffs WHERE status = 'pending'").get() as any)?.c || 0;

    return {
      totalNodes: nodes.length,
      onlineNodes: online,
      offlineNodes: nodes.length - online,
      totalCapacity,
      activeAgents,
      pendingHandoffs,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private parseNode(row: any): FleetNode {
    return {
      id: row.id,
      name: row.name,
      endpoint: row.endpoint,
      status: row.status,
      capabilities: JSON.parse(row.capabilities_json || '[]'),
      activeAgents: row.active_agents,
      maxAgents: row.max_agents,
      lastHeartbeat: row.last_heartbeat,
      metadata: JSON.parse(row.metadata_json || '{}'),
    };
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fleet_nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'offline' CHECK(status IN ('online', 'offline', 'degraded')),
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        active_agents INTEGER NOT NULL DEFAULT 0,
        max_agents INTEGER NOT NULL DEFAULT 10,
        last_heartbeat TEXT NOT NULL DEFAULT (datetime('now')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_fleet_nodes_status ON fleet_nodes(status);
      CREATE INDEX IF NOT EXISTS idx_fleet_nodes_endpoint ON fleet_nodes(endpoint);

      CREATE TABLE IF NOT EXISTS fleet_handoffs (
        id TEXT PRIMARY KEY,
        from_node TEXT NOT NULL,
        to_node TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        lease_id TEXT,
        context_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected', 'completed')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS fleet_work_distribution (
        id TEXT PRIMARY KEY,
        loop_run_id TEXT NOT NULL,
        assigned_node TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        priority INTEGER NOT NULL DEFAULT 5,
        status TEXT NOT NULL DEFAULT 'assigned' CHECK(status IN ('assigned', 'accepted', 'in_progress', 'completed')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS fleet_capability_sync (
        id TEXT PRIMARY KEY,
        source_node TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        capability_type TEXT NOT NULL DEFAULT '',
        score REAL NOT NULL DEFAULT 0,
        synced_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
}
