/**
 * HandoffService — agent-to-agent work transfer.
 *
 * Extracted from SwarmStatusService (Phase B2 decomposition).
 * Handles: handoff creation, acceptance, draining.
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface AgentHandoffInput {
  from_agent_id: string;
  to_agent_id: string;
  summary: string;
  source_lease_id?: string;
  work_item_id?: string;
  task_id?: string;
  priority?: 'low' | 'medium' | 'high';
  context?: Record<string, unknown>;
}

export interface AgentHandoffAcceptResult {
  id: string;
  status: 'accepted';
  from_agent_id: string;
  to_agent_id: string;
}

export interface AgentHandoffDrainResult {
  drained: number;
  completed: number;
  failed: number;
}

export class HandoffService {
  constructor(private db: Database) {}

  async createHandoff(input: AgentHandoffInput): Promise<{
    id: string;
    from_agent_id: string;
    to_agent_id: string;
    summary: string;
    status: string;
    priority: string;
    created_at: string;
  }> {
    // Validate required fields
    if (!input.from_agent_id?.trim()) throw new Error('SWARM_HANDOFF_SOURCE_REQUIRED');
    if (!input.to_agent_id?.trim()) throw new Error('SWARM_HANDOFF_TARGET_REQUIRED');
    if (!input.summary?.trim()) throw new Error('SWARM_HANDOFF_SUMMARY_REQUIRED');
    if (!input.source_lease_id && !input.work_item_id && !input.task_id) {
      throw new Error('SWARM_HANDOFF_SOURCE_REQUIRED');
    }

    const validPriorities = ['low', 'medium', 'high'];
    const priority = input.priority || 'medium';
    if (!validPriorities.includes(priority)) throw new Error('SWARM_HANDOFF_PRIORITY_INVALID');

    const id = randomUUID();
    const now = new Date().toISOString();

    // Check for duplicate active handoff
    const existing = this.db.prepare(`
      SELECT id FROM fleet_handoffs
      WHERE from_node = ? AND to_node = ? AND status = 'pending'
      AND created_at > datetime('now', '-1 hour')
    `).get(input.from_agent_id, input.to_agent_id) as any;

    if (existing) {
      throw new Error('SWARM_HANDOFF_ALREADY_PENDING');
    }

    this.db.prepare(`
      INSERT INTO fleet_handoffs (id, from_node, to_node, agent_id, lease_id, context_json, status, priority, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      id, input.from_agent_id, input.to_agent_id, input.to_agent_id,
      input.source_lease_id || input.work_item_id || input.task_id || null,
      JSON.stringify(input.context || {}), priority, now
    );

    return {
      id,
      from_agent_id: input.from_agent_id,
      to_agent_id: input.to_agent_id,
      summary: input.summary,
      status: 'pending',
      priority,
      created_at: now,
    };
  }

  acceptHandoff(id: string): AgentHandoffAcceptResult {
    const existing = this.db.prepare('SELECT * FROM fleet_handoffs WHERE id = ?').get(id) as any;
    if (!existing) throw new Error('SWARM_HANDOFF_NOT_FOUND');
    if (existing.status !== 'pending') throw new Error('SWARM_HANDOFF_ALREADY_ACCEPTED');

    this.db.prepare("UPDATE fleet_handoffs SET status = 'accepted' WHERE id = ?").run(id);

    return {
      id,
      status: 'accepted',
      from_agent_id: existing.from_node,
      to_agent_id: existing.to_node,
    };
  }

  async drainHandoffs(input: { agent_id?: string } = {}): Promise<AgentHandoffDrainResult> {
    let query = "UPDATE fleet_handoffs SET status = 'completed' WHERE status = 'pending'";
    const params: unknown[] = [];

    if (input.agent_id) {
      query += ' AND to_node = ?';
      params.push(input.agent_id);
    }

    const result = this.db.prepare(query).run(...params);

    return {
      drained: result.changes,
      completed: result.changes,
      failed: 0,
    };
  }
}
