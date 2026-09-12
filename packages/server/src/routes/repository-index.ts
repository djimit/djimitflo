/**
 * Repository Index routes — per-repository code indexing and search.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { RepositoryIndexService } from '../services/repository-index-service';

function boundedWindow(value: unknown, fallback: number, minimum: number, maximum: number): number | null {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

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
    if (typeof name !== 'string' || !name.trim() || typeof path !== 'string' || !path.trim()
      || (url !== undefined && typeof url !== 'string')) {
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
      const message = error instanceof Error ? error.message : String(error);
      res.status(/^Repository not found:/.test(message) ? 404 : 500).json({ error: { message, code: /^Repository not found:/.test(message) ? 'REPOSITORY_NOT_FOUND' : 'REPOSITORY_INDEX_ERROR' } });
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
    const validSearchType = search_type === undefined || ['hybrid', 'vector', 'keyword'].includes(search_type);
    if (typeof query !== 'string' || !query.trim()
      || (repository_id !== undefined && typeof repository_id !== 'string')
      || (file_pattern !== undefined && typeof file_pattern !== 'string')
      || (language !== undefined && typeof language !== 'string')
      || !validSearchType) {
      res.status(400).json({ error: { message: 'query is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const boundedLimit = boundedWindow(limit, 10, 1, 500);
    const boundedOffset = boundedWindow(offset, 0, 0, 1_000_000);
    if (boundedLimit === null || boundedOffset === null) {
      res.status(400).json({ error: { message: 'limit must be an integer between 1 and 500 and offset between 0 and 1000000', code: 'VALIDATION_ERROR' } });
      return;
    }
    const results = service.search({
      query,
      repository_id,
      file_pattern,
      language,
      limit: boundedLimit,
      offset: boundedOffset,
      search_type: search_type || 'hybrid',
    });
    res.json({ results, count: results.length });
  });

  // DELETE /api/repo-index/:id — delete a repository index
  router.delete('/:id', requirePermission('write:governance'), (req, res) => {
    try {
      service.deleteRepository(req.params.id);
      res.status(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/^Repository not found:/.test(message)) {
        res.status(404).json({ error: { message, code: 'REPOSITORY_NOT_FOUND' } });
        return;
      }
      throw error;
    }
  });

  return router;
}
