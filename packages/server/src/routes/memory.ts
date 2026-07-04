/**
 * Proactive Memory routes — relevance-scored, self-maintaining memory substrate.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { ProactiveMemoryService } from '../services/proactive-memory-service';

export function createMemoryRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const service = new ProactiveMemoryService(db);

  // GET /api/memory/stats — memory statistics
  router.get('/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(service.getStats());
  });

  // GET /api/memory/top — most relevant active memories
  router.get('/top', requirePermission('read:evidence'), (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const type = req.query.type as string | undefined;
    res.json({ memories: service.getTopMemories(limit, type) });
  });

  // POST /api/memory/store — store a new memory
  router.post('/store', requirePermission('write:claim'), (req, res) => {
    const { content, type, metadata, ttlDays } = req.body;
    if (!content?.trim()) {
      res.status(400).json({ error: { message: 'content is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const entry = service.storeMemory({ content, type: type || 'observation', metadata, ttlDays });
    res.status(201).json(entry);
  });

  // GET /api/memory/search — search memories by content
  router.get('/search', requirePermission('read:evidence'), (req, res) => {
    const q = req.query.q as string;
    if (!q?.trim()) {
      res.status(400).json({ error: { message: 'q parameter is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const limit = req.query.limit ? Number(req.query.limit) : 10;
    res.json({ memories: service.searchMemories(q, limit) });
  });

  // GET /api/memory/:id — get a memory and update usage
  router.get('/:id', requirePermission('read:evidence'), (req, res) => {
    const memory = service.accessMemory(req.params.id);
    if (!memory) {
      res.status(404).json({ error: { message: 'Memory not found', code: 'NOT_FOUND' } });
      return;
    }
    res.json(memory);
  });

  // GET /api/memory/:id/related — get related memories
  router.get('/:id/related', requirePermission('read:evidence'), (req, res) => {
    res.json({ related: service.getRelatedMemories(req.params.id) });
  });

  // POST /api/memory/relations — create a relation between memories
  router.post('/relations', requirePermission('write:claim'), (req, res) => {
    const { sourceId, targetId, relationType, strength } = req.body;
    if (!sourceId || !targetId) {
      res.status(400).json({ error: { message: 'sourceId and targetId are required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const relation = service.createRelation(sourceId, targetId, relationType || 'related', strength || 0.5);
    res.status(201).json(relation);
  });

  // POST /api/memory/maintenance — run maintenance cycle
  router.post('/maintenance', requirePermission('write:governance'), (__req, res) => {
    const result = service.runMaintenanceCycle();
    res.json(result);
  });

  return router;
}
