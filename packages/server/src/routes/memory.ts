/**
 * Memory routes — semantic search and context injection endpoints
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { ContextInjectionService } from '../services/context-injection-service';

export function createMemoryRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requireAuth = auth?.requireAuth ?? ((_req: any, _res: any, next: any) => next());
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const contextInjector = new ContextInjectionService();

  // GET /api/memory/search?q=<query>&limit=<n>
  router.get('/search', requireAuth, requirePermission('read:evidence'), async (req, res, _next): Promise<void> => {
    const query = (req.query.q as string || '').trim();
    if (!query) {
      res.json({ results: [], total: 0 });
      return;
    }

    const localResults = searchPromotedMemory(db, query);
    if (localResults.length > 0) {
      res.json({ results: localResults, total: localResults.length, source: 'promoted_memory_fallback' });
      return;
    }

    const context = await contextInjector.injectContext(query, true);
    const results = context
      ? context.split('### ').slice(1).map((block: string) => {
          const lines = block.split('\n');
          const titleLine = lines[0] || '';
          const trustMatch = titleLine.match(/\[(approved|validated|agent_generated)\]/);
          return {
            title: titleLine.replace(/\[.*?\]/, '').trim(),
            excerpt: lines.slice(1).join(' ').trim().slice(0, 200),
            trust_level: trustMatch ? trustMatch[1] : undefined,
          };
        })
      : [];

    res.json({ results, total: results.length });
  });

  return router;
}

function searchPromotedMemory(db: Database, query: string): Array<Record<string, unknown>> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3)
    .slice(0, 8);
  if (terms.length === 0) {
    return [];
  }
  let rows: any[] = [];
  try {
    rows = db.prepare(`
      SELECT * FROM memory_candidates
      WHERE promotion_status = 'promoted'
      ORDER BY updated_at DESC
      LIMIT 50
    `).all() as any[];
  } catch {
    return [];
  }
  return rows
    .map((row) => ({
      row,
      score: terms.filter((term) => `${row.title} ${row.content}`.toLowerCase().includes(term)).length,
    }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((hit) => ({
      title: hit.row.title,
      excerpt: String(hit.row.content).slice(0, 200),
      trust_level: 'validated',
      memory_type: hit.row.memory_type,
      source_ref: hit.row.source_ref || undefined,
      score: hit.score,
    }));
}
