import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DbHandle } from '../db.js';

const apiBase = () => (process.env.DJIMITFLO_API_URL || 'http://127.0.0.1:3001/api').replace(/\/$/, '');

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(process.env.DJIMITFLO_API_TOKEN ? { authorization: `Bearer ${process.env.DJIMITFLO_API_TOKEN}` } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`DJIMITFLO_API_ERROR:${response.status}:${await response.text()}`);
  return response;
}

export function registerPlatformTools(server: McpServer, dbHandle: DbHandle): void {
  server.registerTool('djimitflo_council_ask', {
    description: 'Ask the Djimitflo multi-model council and return its synthesized answer',
    inputSchema: {
      question: z.string().min(1),
      mode: z.enum(['fast', 'review', 'council']).default('council').optional(),
      independentJudge: z.boolean().default(false).optional(),
      judgeModel: z.string().optional(),
    },
  }, async ({ question, mode = 'council', independentJudge = false, judgeModel }) => {
    const created = await api('/council/sessions', {
      method: 'POST',
      body: JSON.stringify({ task_description: question, mode, independent_judge: independentJudge, judge_model: judgeModel }),
    }).then(response => response.json()) as { id: string };
    const result = await api(`/council/sessions/${created.id}/execute`, { method: 'POST', body: '{}' }).then(response => response.json());
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.registerTool('djimitflo_memory_search', {
    description: 'Search Djimitflo memory candidates by title and content',
    inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(50).default(10).optional() },
  }, async ({ query, limit = 10 }) => {
    const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    const rows = dbHandle.db.prepare(`
      SELECT id, title, content, memory_type, status, source_ref, metadata, created_at
      FROM memory_candidates
      WHERE title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'
      ORDER BY CASE WHEN status = 'promoted' THEN 0 ELSE 1 END, created_at DESC
      LIMIT ?
    `).all(pattern, pattern, limit);
    return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] };
  });

  server.registerTool('djimitflo_generate_export', {
    description: 'Generate a Djimitflo task, evidence, audit, repository, or summary export through the authenticated API',
    inputSchema: {
      target: z.enum(['task', 'evidence', 'audit', 'repository', 'summary']),
      id: z.string().optional(),
      format: z.enum(['json', 'csv', 'markdown']).default('json').optional(),
    },
  }, async ({ target, id, format = 'json' }) => {
    if (['task', 'evidence', 'repository'].includes(target) && !id) throw new Error('DJIMITFLO_EXPORT_ID_REQUIRED');
    const path = target === 'summary' ? '/exports/report/summary' : target === 'audit' ? '/exports/audit' : `/exports/${target}/${id}`;
    const response = await api(path, { method: 'POST', body: JSON.stringify({ format }) });
    return { content: [{ type: 'text' as const, text: await response.text() }] };
  });
}
