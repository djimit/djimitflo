/**
 * Loop orchestration MCP tools.
 * Exposes: start_loop, continue_loop, get_loop_status, list_loop_runs
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DbHandle } from '../db.js';

export function registerLoopTools(server: McpServer, dbHandle: DbHandle) {
  const { db } = dbHandle;

  server.registerTool(
    'djimitflo_list_loop_runs',
    {
      description: 'List recent loop runs with their status, loop name, and creation time',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20).optional(),
        status: z.enum(['created', 'running', 'verifying', 'blocked', 'completed', 'escalated', 'failed']).optional(),
      },
    },
    async ({ limit = 20, status }) => {
      let query = 'SELECT id, loop_name, mode, status, created_at, updated_at, completed_at FROM loop_runs';
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
    'djimitflo_get_loop_status',
    {
      description: 'Get detailed status of a loop run including gates, leases, and next actions',
      inputSchema: {
        runId: z.string().describe('The loop run ID'),
      },
    },
    async ({ runId }) => {
      const run = db.prepare('SELECT * FROM loop_runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined;
      if (!run) {
        return { content: [{ type: 'text' as const, text: `Loop run not found: ${runId}` }], isError: true };
      }

      const leases = db.prepare('SELECT id, role, status, runtime, created_at FROM worker_leases WHERE loop_run_id = ? ORDER BY created_at DESC LIMIT 20').all(runId);
      const events = db.prepare('SELECT event_type, severity, message, created_at FROM loop_events WHERE loop_run_id = ? ORDER BY created_at DESC LIMIT 10').all(runId);

      const gatesJson = (run.gates_json as string) || '[]';
      const nextActionsJson = (run.next_actions_json as string) || '[]';

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            run,
            gates: JSON.parse(gatesJson),
            nextActions: JSON.parse(nextActionsJson),
            leases,
            recentEvents: events,
          }, null, 2),
        }],
      };
    }
  );

  server.registerTool(
    'djimitflo_get_loop_catalog',
      {
        description: 'List available loop types (catalog of loop names and their descriptions)',
        inputSchema: {},
      },
    async () => {
      const catalog = [
        { name: 'doc-drift-and-small-fix-loop', description: 'Detects documentation drift and small fix opportunities in repository files', mode: 'closed' },
        { name: 'github-issue-loop', description: 'Processes GitHub issues through maker/checker workflow', mode: 'open' },
        { name: 'self-improvement-loop', description: 'Autonomous self-improvement based on reflections and evidence', mode: 'closed' },
      ];
      return { content: [{ type: 'text' as const, text: JSON.stringify(catalog, null, 2) }] };
    }
  );
}
