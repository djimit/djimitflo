/**
 * Multi-agent orchestration MCP tools.
 *
 * Exposes: spawn_agent, handoff_agent, approve_action, list_agents
 *
 * Registration, handoff requests and human review are control-plane records.
 * They do not themselves launch an executor or transfer a running process.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { requireLiveMode, type DbHandle } from '../db.js';
import { ROLE_PERMISSIONS } from '@djimitflo/shared';
import { currentMcpAuth } from '../auth-context.js';
import { api } from './platform.js';

function requirePermission(permission: string) {
  const principal = currentMcpAuth().payload;
  if (!ROLE_PERMISSIONS[principal.role]?.includes(permission)) throw new Error(`MCP_PERMISSION_DENIED: ${permission}`);
  return principal;
}

export function registerOrchestrationTools(server: McpServer, dbHandle: DbHandle) {
  const { db } = dbHandle;

  // ─── spawn_agent ──────────────────────────────────────────────────────
  server.registerTool(
    'djimitflo_spawn_agent',
    {
      description: 'Registration-only legacy spawn tool: create an idle agent record with requested task/runtime metadata. Does not create or execute a task, allocate context or scratch space, or start a worker. Actual execution requires a separately authorized task execution or governed loop.',
      inputSchema: {
        task: z.string().min(1).describe('Requested work description stored on the agent; no task is created'),
        runtime: z.enum(['mock', 'codex', 'opencode', 'claude', 'gemini', 'editor']).default('mock').describe('Requested runtime metadata; availability is not checked and no runtime is started'),
        role: z.enum(['planner', 'maker', 'checker', 'security_checker', 'memory_curator', 'governance_guard']).default('maker').describe('Role of the sub-agent'),
        context_budget: z.number().int().min(500).max(100000).default(4000).describe('Requested context budget metadata only; not allocated or enforced'),
        parent_run_id: z.string().optional().describe('Requested parent run metadata only; does not attach a worker to the loop'),
      },
    },
    async ({ task, runtime, role, context_budget, parent_run_id }) => {
      requireLiveMode(dbHandle);
      const principal = requirePermission('write:swarm_action');
      const agentId = `agent-${randomUUID()}`;

      // Compatibility registration only; dispatch belongs to the task/loop services.
      db.prepare(`
        INSERT INTO agents (id, name, description, status, capabilities, model, metadata, created_at, updated_at)
        VALUES (?, ?, ?, 'idle', ?, NULL, ?, datetime('now'), datetime('now'))
      `).run(
        agentId,
        `${role}-${runtime}-${agentId}`,
        task,
        JSON.stringify([role]),
        JSON.stringify({ parent_run_id, requested_runtime: runtime, context_budget, context_budget_enforced: false, registration_only: true, spawned_by: principal.sub, spawned_by_role: principal.role })
      );

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            agent_id: agentId,
            status: 'idle',
            registration_only: true,
            execution_started: false,
            context_budget_enforced: false,
            runtime,
            role,
            context_budget,
            task: task.slice(0, 200),
            message: 'Idle agent registered; no task, worker, context allocation or execution was started. Use a separately authorized task execution or governed loop to perform work.',
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
        from_node_id: z.string().describe('Fleet node handing off the agent'),
        to_node_id: z.string().describe('Fleet node receiving the agent'),
        agent_id: z.string().describe('Agent being handed off'),
        lease_id: z.string().describe('Worker lease transferred with the agent'),
        summary: z.string().describe('Summary of work completed and context for the receiving agent'),
        artifacts: z.array(z.string()).default([]).describe('List of artifact references (file paths, URLs, scratch keys)'),
      },
    },
    async ({ from_node_id, to_node_id, agent_id, lease_id, summary, artifacts }) => {
      requireLiveMode(dbHandle);
      const principal = requirePermission('write:swarm_action');
      if (!db.prepare('SELECT 1 FROM fleet_nodes WHERE id = ?').get(from_node_id)
        || !db.prepare('SELECT 1 FROM fleet_nodes WHERE id = ?').get(to_node_id)) {
        return { content: [{ type: 'text' as const, text: 'Unknown fleet node' }], isError: true };
      }
      if (!db.prepare('SELECT 1 FROM agents WHERE id = ?').get(agent_id)) {
        return { content: [{ type: 'text' as const, text: 'Unknown agent' }], isError: true };
      }
      if (!db.prepare('SELECT 1 FROM worker_leases WHERE id = ?').get(lease_id)) {
        return { content: [{ type: 'text' as const, text: 'Unknown worker lease' }], isError: true };
      }

      const handoffId = randomUUID();
      db.prepare(`
        INSERT INTO fleet_handoffs (id, from_node, to_node, agent_id, lease_id, context_json, status, priority, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', 'medium', datetime('now'))
      `).run(handoffId, from_node_id, to_node_id, agent_id, lease_id, JSON.stringify({ summary, artifacts, principal_id: principal.sub, principal_role: principal.role }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            handoff_id: handoffId,
            from: from_node_id,
            to: to_node_id,
            agent_id,
            lease_id,
            status: 'pending',
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
        task_id: z.string().min(1).describe('Existing task to which the requested action belongs'),
        action: z.string().describe('The action requiring approval'),
        reason: z.string().describe('Why approval is needed'),
        risk_level: z.enum(['low', 'medium', 'high', 'critical']).describe('Risk level of the action'),
        context: z.record(z.string(), z.unknown()).default({}).describe('Additional context for the approver'),
      },
    },
    async ({ task_id, action, reason, risk_level, context }) => {
      requireLiveMode(dbHandle);
      requirePermission('create:task');
      const approval = await api('/approvals', {
        method: 'POST', body: JSON.stringify({ task_id, action, reason, risk_level, context }),
      }).then(response => response.json()) as { id: string };

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            approval_id: approval.id,
            task_id,
            status: 'pending',
            action: action.slice(0, 200),
            risk_level,
            message: `Approval requested for ${risk_level}-risk action. Dashboard/API review records the decision; it does not execute the action.`,
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
        status: z.enum(['idle', 'active', 'paused', 'error', 'offline', 'handoff_complete']).optional().describe('Filter by status'),
      },
    },
    async ({ status }) => {
      let query = `SELECT id, name, description, status, capabilities, model,
        COALESCE(last_heartbeat_at, last_active_at, updated_at) AS last_seen,
        created_at, updated_at FROM agents`;
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
