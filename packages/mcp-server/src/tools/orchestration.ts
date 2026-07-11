/**
 * Multi-agent orchestration MCP tools.
 *
 * Exposes: spawn_agent, handoff_agent, approve_action, list_agents
 *
 * These tools enable agent-to-agent delegation and human-in-the-loop
 * approval gating, following the OpenAI Agents SDK handoff pattern.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DbHandle } from '../db.js';

export function registerOrchestrationTools(server: McpServer, dbHandle: DbHandle) {
  const { db } = dbHandle;

  // ─── spawn_agent ──────────────────────────────────────────────────────
  server.registerTool(
    'djimitflo_spawn_agent',
    {
      description: 'Spawn a sub-agent to handle a specific task with isolated context. The sub-agent gets its own context window, tool budget, and scratch space.',
      inputSchema: {
        task: z.string().describe('The task description for the sub-agent'),
        runtime: z.enum(['mock', 'codex', 'opencode', 'claude', 'gemini', 'editor']).default('mock').describe('Runtime to use for the sub-agent'),
        role: z.enum(['planner', 'maker', 'checker', 'security_checker', 'memory_curator', 'governance_guard']).default('maker').describe('Role of the sub-agent'),
        context_budget: z.number().int().min(500).max(100000).default(4000).describe('Token budget for the sub-agent context window'),
        parent_run_id: z.string().optional().describe('Parent loop run ID (if spawning from within a loop)'),
      },
    },
    async ({ task, runtime, role, context_budget, parent_run_id }) => {
      const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Register the sub-agent
      db.prepare(`
        INSERT INTO agents (id, name, description, status, capabilities, model, metadata, created_at, updated_at)
        VALUES (?, ?, ?, 'idle', ?, 'workstation-litellm/coding', ?, datetime('now'), datetime('now'))
      `).run(
        agentId,
        `${role}-${runtime}`,
        task,
        JSON.stringify([role]),
        JSON.stringify({ parent_run_id, context_budget, spawned_by: 'mcp-orchestrator' })
      );

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            agent_id: agentId,
            status: 'spawned',
            runtime,
            role,
            context_budget,
            task: task.slice(0, 200),
            message: `Sub-agent spawned with ${context_budget} token budget. Use djimitflo_get_agent_status to monitor progress.`,
          }, null, 2),
        }],
      };
    }
  );

  // ─── handoff_agent ────────────────────────────────────────────────────
  server.registerTool(
    'djimitflo_handoff_agent',
    {
      description: 'Hand off work from one agent to another with context transfer. The receiving agent gets a summary of the work done so far.',
      inputSchema: {
        from_agent_id: z.string().describe('The agent ID that is handing off'),
        to_agent_id: z.string().describe('The agent ID that receives the work'),
        summary: z.string().describe('Summary of work completed and context for the receiving agent'),
        artifacts: z.array(z.string()).default([]).describe('List of artifact references (file paths, URLs, scratch keys)'),
      },
    },
    async ({ from_agent_id, to_agent_id, summary, artifacts }) => {
      // Update agent statuses
      db.prepare("UPDATE agents SET status = 'handoff_complete', updated_at = datetime('now') WHERE id = ?").run(from_agent_id);
      db.prepare("UPDATE agents SET status = 'active', updated_at = datetime('now') WHERE id = ?").run(to_agent_id);

      // Store handoff record
      const handoffId = `handoff-${Date.now()}`;
      db.prepare(`
        INSERT INTO fleet_handoffs (id, from_node, to_node, agent_id, context_json, status, priority, created_at)
        VALUES (?, ?, ?, ?, ?, 'completed', 'medium', datetime('now'))
      `).run(handoffId, from_agent_id, to_agent_id, to_agent_id, JSON.stringify({ summary, artifacts }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            handoff_id: handoffId,
            from: from_agent_id,
            to: to_agent_id,
            status: 'completed',
            artifacts_transferred: artifacts.length,
          }, null, 2),
        }],
      };
    }
  );

  // ─── approve_action ───────────────────────────────────────────────────
  server.registerTool(
    'djimitflo_approve_action',
    {
      description: 'Request human approval for a high-risk action. Returns a pending approval that must be confirmed before the action proceeds.',
      inputSchema: {
        action: z.string().describe('The action requiring approval'),
        reason: z.string().describe('Why approval is needed'),
        risk_level: z.enum(['low', 'medium', 'high', 'critical']).describe('Risk level of the action'),
        context: z.record(z.unknown()).default({}).describe('Additional context for the approver'),
      },
    },
    async ({ action, reason, risk_level, context }) => {
      const approvalId = `approval-${Date.now()}`;

      // Store approval request using existing approvals table
      db.prepare(`
        INSERT INTO approvals (id, task_id, status, risk_level, request_type, request_message, request_data, created_at)
        VALUES (?, 'mcp-orchestrator', 'pending', ?, 'high_risk_action', ?, ?, datetime('now'))
      `).run(approvalId, risk_level, action, JSON.stringify({ reason, context }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            approval_id: approvalId,
            status: 'pending',
            action: action.slice(0, 200),
            risk_level,
            message: `Approval requested for ${risk_level}-risk action. Use the DjimFlo dashboard or API to approve/reject.`,
          }, null, 2),
        }],
      };
    }
  );

  // ─── list_agents ──────────────────────────────────────────────────────
  server.registerTool(
    'djimitflo_list_agents',
    {
      description: 'List all agents with their current status, capabilities, and active tasks',
      inputSchema: {
        status: z.enum(['idle', 'active', 'paused', 'error', 'offline', 'handoff_complete']).optional().describe('Filter by status'),
      },
    },
    async ({ status }) => {
      let query = 'SELECT id, name, description, status, capabilities, model, last_seen, created_at, updated_at FROM agents';
      const params: unknown[] = [];

      if (status) {
        query += ' WHERE status = ?';
        params.push(status);
      }

      query += ' ORDER BY updated_at DESC LIMIT 50';

      const rows = db.prepare(query).all(...params) as any[];

      const agents = rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        status: row.status,
        capabilities: JSON.parse(row.capabilities || '[]'),
        model: row.model,
        last_seen: row.last_seen,
        created_at: row.created_at,
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ agents, total: agents.length }, null, 2),
        }],
      };
    }
  );
}
