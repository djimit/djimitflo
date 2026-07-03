/**
 * Goal management MCP tools.
 * Exposes: list_goals, get_goal, create_goal
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DbHandle } from '../db.js';

export function registerGoalTools(server: McpServer, dbHandle: DbHandle) {
  const { db } = dbHandle;

  server.registerTool(
    'djimitflo_list_goals',
    {
      description: 'List goals with their status, risk class, and priority',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(20).optional(),
        status: z.enum(['created', 'approved', 'in_progress', 'completed', 'failed']).optional(),
      }),
    },
    async ({ limit = 20, status }) => {
      let query = 'SELECT id, objective, status, risk_class, budget_json, created_at, updated_at FROM goals';
      const params: unknown[] = [];
      if (status) {
        query += ' WHERE status = ?';
        params.push(status);
      }
      query += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);

      const rows = db.prepare(query).all(...params) as Array<Record<string, unknown>>;
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] };
    }
  );

  server.registerTool(
    'djimitflo_get_goal',
    {
      description: 'Get detailed information about a specific goal',
      inputSchema: z.object({
        goalId: z.string().describe('The goal ID'),
      }),
    },
    async ({ goalId }) => {
      const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId) as Record<string, unknown> | undefined;
      if (!goal) {
        return { content: [{ type: 'text' as const, text: `Goal not found: ${goalId}` }], isError: true };
      }

      const runs = db.prepare('SELECT id, loop_name, status, created_at FROM loop_runs WHERE goal_id = ? ORDER BY created_at DESC LIMIT 10').all(goalId);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ goal, runs }, null, 2),
        }],
      };
    }
  );
}
