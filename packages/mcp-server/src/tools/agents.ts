/**
 * Agent management MCP tools.
 * Exposes: list_agents, get_agent_status
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DbHandle } from '../db.js';

export function registerAgentTools(server: McpServer, dbHandle: DbHandle) {
  const { db } = dbHandle;

  server.registerTool(
    'djimitflo_list_agents',
    {
      description: 'List registered agents with their status and capabilities',
      inputSchema: z.object({
        status: z.enum(['idle', 'active', 'paused', 'error', 'offline']).optional(),
      }),
    },
    async ({ status }) => {
      let query = 'SELECT id, name, status, agent_type, capabilities_json, last_seen FROM agents';
      const params: unknown[] = [];
      if (status) {
        query += ' WHERE status = ?';
        params.push(status);
      }
      query += ' ORDER BY last_seen DESC';

      const rows = db.prepare(query).all(...params) as Array<Record<string, unknown>>;
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] };
    }
  );

  server.registerTool(
    'djimitflo_get_agent_status',
    {
      description: 'Get detailed status of a specific agent',
      inputSchema: z.object({
        agentId: z.string().describe('The agent ID'),
      }),
    },
    async ({ agentId }) => {
      const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Record<string, unknown> | undefined;
      if (!agent) {
        return { content: [{ type: 'text' as const, text: `Agent not found: ${agentId}` }], isError: true };
      }

      const activeLeases = db.prepare("SELECT id, loop_run_id, role, status FROM worker_leases WHERE spawned_by_agent_id = ? AND status IN ('running','prepared')").all(agentId);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ agent, activeLeases }, null, 2),
        }],
      };
    }
  );
}
