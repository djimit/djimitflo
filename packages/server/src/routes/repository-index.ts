/**
 * Repository Index routes — per-repository code indexing and search.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { RepositoryIndexService } from '../services/repository-index-service';

export function createRepositoryIndexRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const service = new RepositoryIndexService(db);

  // GET /api/repo-index/repositories — list registered repositories
  router.get('/repositories', requirePermission('read:repository'), (_req, res) => {
    const repos = service.listRepositories();
    res.json({ repositories: repos, count: repos.length });
  });

  // POST /api/repo-index/register — register a repository
  router.post('/register', requirePermission('write:governance'), (req, res) => {
    const { name, path, url } = req.body;
    if (!name || !path) {
      res.status(400).json({ error: { message: 'name and path are required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const repo = service.registerRepository(name, path, url);
    res.status(201).json(repo);
  });

  // POST /api/repo-index/:id/index — index a repository
  router.post('/:id/index', requirePermission('write:governance'), async (req, res) => {
    try {
      const stats = await service.indexRepository(req.params.id);
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: { message: error instanceof Error ? error.message : String(error) } });
    }
  });

  // GET /api/repo-index/:id/stats — get index statistics
  router.get('/:id/stats', requirePermission('read:repository'), (req, res) => {
    try {
      const stats = service.getStats(req.params.id);
      res.json(stats);
    } catch (error) {
      res.status(404).json({ error: { message: error instanceof Error ? error.message : String(error) } });
    }
  });

  // POST /api/repo-index/search — search indexed repositories
  router.post('/search', requirePermission('read:repository'), (req, res) => {
    const { query, repository_id, file_pattern, language, limit, offset, search_type } = req.body;
    if (!query) {
      res.status(400).json({ error: { message: 'query is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const results = service.search({
      query,
      repository_id,
      file_pattern,
      language,
      limit: limit || 10,
      offset: offset || 0,
      search_type: search_type || 'hybrid',
    });
    res.json({ results, count: results.length });
  });

  // DELETE /api/repo-index/:id — delete a repository index
  router.delete('/:id', requirePermission('write:governance'), (req, res) => {
    service.deleteRepository(req.params.id);
    res.status(204).send();
  });

  return router;
}
