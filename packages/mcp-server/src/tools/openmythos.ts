/**
 * OpenMythos governance MCP tools.
 * Exposes: openmythos_leaderboard, openmythos_score
 *
 * Read-only views over openmythos_eval_runs — evals themselves are started
 * via the REST API (POST /api/openmythos/eval/:agentId), not from MCP.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DbHandle } from '../db.js';

interface RunRow {
  id: string;
  agent_id: string;
  status: string;
  total_cases: number;
  completed_cases: number;
  overall_score: number;
  started_at: string | null;
  finished_at: string | null;
  metadata: string;
}

function parseMetadata(raw: string): { subject_model?: string; category_scores?: Record<string, number>; oracle_cases?: number; judge_cases?: number } {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

export function registerOpenMythosTools(server: McpServer, dbHandle: DbHandle) {
  const { db } = dbHandle;

  server.registerTool(
    'djimitflo_openmythos_leaderboard',
    {
      description: 'Governance leaderboard: latest OpenMythos benchmark score per agent (0-5 scale), best first, with per-category scores',
      inputSchema: {},
    },
    async () => {
      const rows = db.prepare(`
        SELECT r.id, r.agent_id, r.status, r.total_cases, r.completed_cases, r.overall_score, r.started_at, r.finished_at, r.metadata
        FROM openmythos_eval_runs r
        WHERE r.status = 'completed' AND r.finished_at = (
          SELECT MAX(r2.finished_at) FROM openmythos_eval_runs r2
          WHERE r2.agent_id = r.agent_id AND r2.status = 'completed'
        )
        ORDER BY r.overall_score DESC
      `).all() as RunRow[];

      const leaderboard = rows.map((r) => {
        const metadata = parseMetadata(r.metadata);
        return {
          agentId: r.agent_id,
          overallScore: r.overall_score,
          categoryScores: metadata.category_scores ?? {},
          subjectModel: metadata.subject_model ?? null,
          completedCases: r.completed_cases,
          lastEvalAt: r.finished_at,
        };
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(leaderboard, null, 2) }] };
    }
  );

  server.registerTool(
    'djimitflo_openmythos_score',
    {
      description: 'Latest OpenMythos governance score for one agent, with per-category scores and recent score trend',
      inputSchema: {
        agentId: z.string().describe('The agent ID that was evaluated'),
      },
    },
    async ({ agentId }: { agentId: string }) => {
      const runs = db.prepare(`
        SELECT id, agent_id, status, total_cases, completed_cases, overall_score, started_at, finished_at, metadata
        FROM openmythos_eval_runs
        WHERE agent_id = ? AND status = 'completed'
        ORDER BY finished_at DESC
        LIMIT 10
      `).all(agentId) as RunRow[];

      if (runs.length === 0) {
        return { content: [{ type: 'text' as const, text: `No completed OpenMythos evaluations for agent: ${agentId}` }], isError: true };
      }

      const latest = runs[0];
      const metadata = parseMetadata(latest.metadata);
      const score = {
        agentId,
        overallScore: latest.overall_score,
        categoryScores: metadata.category_scores ?? {},
        subjectModel: metadata.subject_model ?? null,
        completedCases: latest.completed_cases,
        lastEvalAt: latest.finished_at,
        trend: runs.slice().reverse().map((r) => ({ date: r.finished_at, score: r.overall_score })),
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(score, null, 2) }] };
    }
  );
}
