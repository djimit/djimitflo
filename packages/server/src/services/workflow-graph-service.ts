/**
 * WorkflowGraphService — branching, parallel, human-gated loop workflows.
 *
 * Learned from Fabro (fabro-sh/fabro):
 * - Define workflows as directed graphs with nodes and edges
 * - Support branching, loops, parallelism, and human approval gates
 * - Multi-model routing per node
 * - Git checkpointing per stage
 *
 * DjimFlo-specific:
 * - Replace linear loop execution with workflow graph
 * - Human approval gates before high-risk operations
 * - Parallel worker execution for independent tasks
 * - Git checkpoint per stage for rollback capability
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

type NodeType = 'start' | 'task' | 'parallel' | 'gate' | 'end';
type NodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'waiting_approval';

interface WorkflowNode {
  id: string;
  type: NodeType;
  label: string;
  prompt?: string;
  status: NodeStatus;
  model?: string;
  requiresApproval?: boolean;
  approvedBy?: string;
  approvedAt?: string;
  outputs?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  condition?: string; // "approved", "success", "failed", etc.
  label?: string;
}

interface Workflow {
  id: string;
  name: string;
  description: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  status: 'draft' | 'running' | 'completed' | 'failed';
  createdAt: string;
}

export class WorkflowGraphService {
  constructor(private db: Database) {
    this.ensureTables();
  }

  /**
   * Create a standard loop workflow with approval gates.
   */
  createStandardLoopWorkflow(loopRunId: string): Workflow {
    const nodes: WorkflowNode[] = [
      { id: 'start', type: 'start', label: 'Start Loop', status: 'completed' },
      { id: 'maker', type: 'task', label: 'Maker Execution', prompt: 'Execute maker lease', status: 'pending' },
      { id: 'checker', type: 'task', label: 'Checker Review', prompt: 'Review maker output', status: 'pending' },
      { id: 'gate', type: 'gate', label: 'Human Approval', requiresApproval: true, status: 'pending' },
      { id: 'security', type: 'task', label: 'Security Review', prompt: 'Run security checks', status: 'pending' },
      { id: 'end', type: 'end', label: 'Complete', status: 'pending' },
    ];

    const edges: WorkflowEdge[] = [
      { id: 'e1', from: 'start', to: 'maker' },
      { id: 'e2', from: 'maker', to: 'checker', condition: 'success' },
      { id: 'e3', from: 'checker', to: 'gate', condition: 'accepted' },
      { id: 'e4', from: 'gate', to: 'security', condition: 'approved' },
      { id: 'e5', from: 'security', to: 'end', condition: 'passed' },
      { id: 'e6', from: 'checker', to: 'maker', condition: 'needs_revision', label: 'Revise' },
    ];

    return this.createWorkflow({
      name: `Loop ${loopRunId}`,
      description: 'Standard loop workflow with approval gates',
      nodes,
      edges,
    });
  }

  /**
   * Create a parallel execution workflow.
   */
  createParallelWorkflow(loopRunId: string, tasks: string[]): Workflow {
    const nodes: WorkflowNode[] = [
      { id: 'start', type: 'start', label: 'Start', status: 'completed' },
      { id: 'parallel', type: 'parallel', label: 'Parallel Execution', status: 'pending' },
    ];

    const edges: WorkflowEdge[] = [];

    for (const task of tasks) {
      const nodeId = `task_${task}`;
      nodes.push({
        id: nodeId,
        type: 'task',
        label: task,
        status: 'pending',
      });
      edges.push({ id: `e_${task}`, from: 'parallel', to: nodeId });
    }

    nodes.push({ id: 'end', type: 'end', label: 'Complete', status: 'pending' });
    for (const task of tasks) {
      edges.push({ id: `e_end_${task}`, from: `task_${task}`, to: 'end' });
    }

    return this.createWorkflow({
      name: `Parallel ${loopRunId}`,
      description: `Parallel execution of ${tasks.length} tasks`,
      nodes,
      edges,
    });
  }

  /**
   * Approve a gate node.
   */
  approveGate(workflowId: string, nodeId: string, approvedBy: string): void {
    this.db.prepare(`
      UPDATE workflow_nodes SET status = 'completed', approved_by = ?, approved_at = ?
      WHERE workflow_id = ? AND id = ?
    `).run(approvedBy, new Date().toISOString(), workflowId, nodeId);
  }

  /**
   * Reject a gate node.
   */
  rejectGate(workflowId: string, nodeId: string): void {
    this.db.prepare(`
      UPDATE workflow_nodes SET status = 'failed'
      WHERE workflow_id = ? AND id = ?
    `).run(workflowId, nodeId);
  }

  /**
   * Get the next executable nodes in a workflow.
   */
  getNextNodes(workflowId: string): WorkflowNode[] {
    const workflow = this.getWorkflow(workflowId);
    if (!workflow) return [];

    // Find nodes whose predecessors are all completed
    const completed = new Set(
      workflow.nodes.filter((n) => n.status === 'completed').map((n) => n.id),
    );

    const executable: WorkflowNode[] = [];
    for (const node of workflow.nodes) {
      if (node.status !== 'pending') continue;

      const predecessors = workflow.edges
        .filter((e) => e.to === node.id)
        .map((e) => e.from);

      if (predecessors.every((p) => completed.has(p))) {
        executable.push(node);
      }
    }

    return executable;
  }

  /**
   * Update node status.
   */
  updateNodeStatus(workflowId: string, nodeId: string, status: NodeStatus, outputs?: Record<string, unknown>): void {
    this.db.prepare(`
      UPDATE workflow_nodes SET status = ?, outputs_json = ?
      WHERE workflow_id = ? AND id = ?
    `).run(status, JSON.stringify(outputs || {}), workflowId, nodeId);

    // Check if workflow is complete
    const remaining = this.db.prepare(`
      SELECT COUNT(*) as c FROM workflow_nodes
      WHERE workflow_id = ? AND status NOT IN ('completed', 'failed')
    `).get(workflowId) as any;

    if (remaining.c === 0) {
      this.db.prepare("UPDATE workflows SET status = 'completed' WHERE id = ?").run(workflowId);
    }
  }

  // ─── Private ──────────────────────────────────────────────────────────

  createWorkflow(input: {
    name: string;
    description: string;
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
  }): Workflow {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO workflows (id, name, description, status, created_at)
      VALUES (?, ?, ?, 'draft', ?)
    `).run(id, input.name, input.description, now);

    for (const node of input.nodes) {
      this.db.prepare(`
        INSERT INTO workflow_nodes (id, workflow_id, type, label, prompt, status, requires_approval, model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(node.id, id, node.type, node.label, node.prompt || null, node.status, node.requiresApproval ? 1 : 0, node.model || null);
    }

    for (const edge of input.edges) {
      this.db.prepare(`
        INSERT INTO workflow_edges (id, workflow_id, from_node, to_node, condition, label)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(edge.id, id, edge.from, edge.to, edge.condition || null, edge.label || null);
    }

    return this.getWorkflow(id)!;
  }

  getWorkflow(id: string): Workflow | null {
    const row = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as any;
    if (!row) return null;

    const nodes = (this.db.prepare('SELECT * FROM workflow_nodes WHERE workflow_id = ?').all(id) as any[]).map((n) => ({
      id: n.id,
      type: n.type,
      label: n.label,
      prompt: n.prompt,
      status: n.status,
      requiresApproval: !!n.requires_approval,
      approvedBy: n.approved_by,
      approvedAt: n.approved_at,
      outputs: JSON.parse(n.outputs_json || '{}'),
    }));

    const edges = (this.db.prepare('SELECT * FROM workflow_edges WHERE workflow_id = ?').all(id) as any[]).map((e) => ({
      id: e.id,
      from: e.from_node,
      to: e.to_node,
      condition: e.condition,
      label: e.label,
    }));

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      nodes,
      edges,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'running', 'completed', 'failed')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS workflow_nodes (
        id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('start', 'task', 'parallel', 'gate', 'end')),
        label TEXT NOT NULL DEFAULT '',
        prompt TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'waiting_approval')),
        requires_approval INTEGER NOT NULL DEFAULT 0,
        approved_by TEXT,
        approved_at TEXT,
        outputs_json TEXT NOT NULL DEFAULT '{}',
        model TEXT,
        PRIMARY KEY (id, workflow_id),
        FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS workflow_edges (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        from_node TEXT NOT NULL,
        to_node TEXT NOT NULL,
        condition TEXT,
        label TEXT,
        FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_workflow_nodes_workflow ON workflow_nodes(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_edges_workflow ON workflow_edges(workflow_id);
    `);
  }
}
