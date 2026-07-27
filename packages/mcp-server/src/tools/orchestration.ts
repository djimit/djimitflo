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

interface OrchestrationOptions {
  controlUrl?: string;
  apiToken?: string;
  fetch?: typeof fetch;
}

function spawnRootUrl(controlUrl: string): string {
  const base = controlUrl.replace(/\/+$/, '');
  if (base.endsWith('/api/swarms/spawns')) return `${base}/root`;
  if (base.endsWith('/api')) return `${base}/swarms/spawns/root`;
  return `${base}/api/swarms/spawns/root`;
}

export function registerOrchestrationTools(
  server: McpServer,
  dbHandle: DbHandle,
  options: OrchestrationOptions = {},
) {
  const { db } = dbHandle;
  const controlUrl = options.controlUrl || process.env.DJIMITFLO_CONTROL_URL || '';
  const apiToken = options.apiToken || process.env.DJIMITFLO_API_TOKEN || '';
  const fetchFn = options.fetch || fetch;

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
        parent_run_id: z.string().describe('Existing loop run ID that owns the spawned root lease'),
      },
    },
    async ({ task, runtime, role, context_budget, parent_run_id }) => {
      if (!controlUrl) {
        return {
          content: [{ type: 'text' as const, text: 'DJIMITFLO_CONTROL_URL is required for real agent spawning' }],
          isError: true,
        };
      }

      const response = await fetchFn(spawnRootUrl(controlUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}),
        },
        body: JSON.stringify({
          loop_run_id: parent_run_id,
          runtime,
          role,
          prompt: task,
          context_budget,
        }),
      });
      const body = await response.json() as Record<string, unknown>;
      if (!response.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ...body,
            status: 'prepared',
            runtime,
            role,
            context_budget,
            task: task.slice(0, 200),
            message: 'Agent root lease prepared by the Djimitflo control plane.',
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
      const handoffId = `handoff-${Date.now()}`;
      const handoff = db.transaction(() => {
        const from = db.prepare('SELECT id FROM agents WHERE id = ?').get(from_agent_id);
        const to = db.prepare('SELECT id FROM agents WHERE id = ?').get(to_agent_id);
        if (!from || !to) throw new Error('HANDOFF_AGENT_NOT_FOUND');

        db.prepare("UPDATE agents SET status = 'idle', last_active_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(from_agent_id);
        db.prepare("UPDATE agents SET status = 'active', last_active_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(to_agent_id);
        db.prepare(`
          INSERT INTO fleet_handoffs (id, from_node, to_node, agent_id, context_json, status, priority, created_at)
          VALUES (?, ?, ?, ?, ?, 'completed', 'medium', datetime('now'))
        `).run(handoffId, from_agent_id, to_agent_id, to_agent_id, JSON.stringify({ summary, artifacts }));
      });
      handoff();

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
        task_id: z.string().describe('Existing task ID that owns the approval request'),
        action: z.string().describe('The action requiring approval'),
        reason: z.string().describe('Why approval is needed'),
        risk_level: z.enum(['low', 'medium', 'high', 'critical']).describe('Risk level of the action'),
        context: z.record(z.unknown()).default({}).describe('Additional context for the approver'),
      },
    },
    async ({ task_id, action, reason, risk_level, context }) => {
      const approvalId = `approval-${Date.now()}`;

      db.prepare(`
        INSERT INTO approvals (id, task_id, status, risk_level, request_type, request_message, request_data, created_at)
        VALUES (?, ?, 'pending', ?, 'high_risk_action', ?, ?, datetime('now'))
      `).run(approvalId, task_id, risk_level, action, JSON.stringify({ reason, context }));

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
    'djimitflo_list_orchestration_agents',
    {
      description: 'List all agents with their current status, capabilities, and active tasks',
      inputSchema: {
        status: z.enum(['idle', 'active', 'paused', 'error', 'offline', 'pending_approval']).optional().describe('Filter by status'),
      },
    },
    async ({ status }) => {
      let query = 'SELECT id, name, description, status, capabilities, model, last_active_at, last_heartbeat_at, created_at, updated_at FROM agents';
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
        last_seen: row.last_heartbeat_at || row.last_active_at,
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
