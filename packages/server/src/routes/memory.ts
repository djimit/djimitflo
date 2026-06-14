/**
 * Memory routes — semantic search and context injection endpoints
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { ContextInjectionService } from '../services/context-injection-service';

export function createMemoryRoutes(_db: Database, auth?: AuthMiddleware): Router {
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