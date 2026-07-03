/**
 * Mission control MCP tools.
 * Exposes: get_mission_control, get_system_health
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DbHandle } from '../db.js';

export function registerMissionControlTools(server: McpServer, dbHandle: DbHandle) {
  const { db } = dbHandle;

  server.registerTool(
    'djimitflo_get_mission_control',
    {
      description: 'Get comprehensive mission control overview: active loops, pending goals, agent status, recent events',
      inputSchema: z.object({}),
    },
    async () => {
      const activeLoans = db.prepare("SELECT COUNT(*) as c FROM loop_runs WHERE status IN ('running','verifying')").get() as { c: number };
      const pendingGoals = db.prepare("SELECT COUNT(*) as c FROM goals WHERE status = 'created'").get() as { c: number };
      const activeAgents = db.prepare("SELECT COUNT(*) as c FROM agents WHERE status = 'active'").get() as { c: number };
      const runningWorkers = db.prepare("SELECT COUNT(*) as c FROM worker_leases WHERE status = 'running'").get() as { c: number };
      const recentEvents = db.prepare('SELECT event_type, severity, message, created_at FROM loop_events ORDER BY created_at DESC LIMIT 5').all();

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            summary: {
              activeLoans: activeLoans.c,
              pendingGoals: pendingGoals.c,
              activeAgents: activeAgents.c,
              runningWorkers: runningWorkers.c,
            },
            recentEvents,
          }, null, 2),
        }],
      };
    }
  );

  server.registerTool(
    'djimitflo_get_system_health',
    {
      description: 'Get system health: database stats, table counts, recent errors',
      inputSchema: z.object({}),
    },
    async () => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
      const tableCounts: Record<string, number> = {};
      for (const { name } of tables) {
        try {
          const row = db.prepare(`SELECT COUNT(*) as c FROM "${name}"`).get() as { c: number };
          tableCounts[name] = row.c;
        } catch { /* skip */ }
      }

      const recentErrors = db.prepare("SELECT event_type, message, created_at FROM loop_events WHERE severity IN ('error','critical') ORDER BY created_at DESC LIMIT 5").all();

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ tableCounts, recentErrors }, null, 2),
        }],
      };
    }
  );
}
