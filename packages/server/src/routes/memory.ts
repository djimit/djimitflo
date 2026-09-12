/**
 * Proactive Memory routes — relevance-scored, self-maintaining memory substrate.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { ProactiveMemoryService } from '../services/proactive-memory-service';
import { createError } from '../middleware/error-handler';

function boundedLimit(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw createError(400, 'limit must be an integer between 1 and 100', 'VALIDATION_ERROR');
  }
  return limit;
}

export function createMemoryRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const service = new ProactiveMemoryService(db);

  // GET /api/memory/stats — memory statistics
  router.get('/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(service.getStats());
  });

  // GET /api/memory/top — most relevant active memories
  router.get('/top', requirePermission('read:evidence'), (req, res, next) => {
    let limit: number;
    try { limit = boundedLimit(req.query.limit, 20); } catch (error) { next(error); return; }
    const type = req.query.type as string | undefined;
    res.json({ memories: service.getTopMemories(limit, type) });
  });

  // POST /api/memory/store — store a new memory
  router.post('/store', requirePermission('write:claim'), async (req, res, next) => {
    const { content, type, metadata, ttlDays } = req.body;
    if (!content?.trim()) {
      res.status(400).json({ error: { message: 'content is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    try {
      const entry = await service.storeMemory({ content, type: type || 'observation', metadata, ttlDays });
      res.status(201).json(entry);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/memory/search — search memories by content
  router.get('/search', requirePermission('read:evidence'), async (req, res, next) => {
    const q = req.query.q as string;
    if (!q?.trim()) {
      res.status(400).json({ error: { message: 'q parameter is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    try {
      const limit = boundedLimit(req.query.limit, 10);
      res.json({ memories: await service.searchMemories(q, limit) });
    } catch (error) {
      next(error);
    }
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
    if (typeof sourceId !== 'string' || !sourceId.trim()
      || typeof targetId !== 'string' || !targetId.trim()
      || (relationType !== undefined && (typeof relationType !== 'string' || !relationType.trim()))
      || (strength !== undefined && (typeof strength !== 'number' || !Number.isFinite(strength) || strength < 0 || strength > 1))) {
      res.status(400).json({ error: { message: 'sourceId, targetId and valid optional relationType/strength are required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const relation = service.createRelation(sourceId, targetId, relationType || 'related', strength || 0.5);
    res.status(201).json(relation);
  });

  // POST /api/memory/maintenance — run maintenance cycle
  router.post('/maintenance', requirePermission('write:governance'), async (__req, res, next) => {
    try {
      res.json(await service.runMaintenanceCycle());
    } catch (error) {
      next(error);
    }
  });

  // POST /api/memory/discover-relations — auto-discover relations between similar memories
  router.post('/discover-relations', requirePermission('write:governance'), async (req, res, next) => {
    const minStrength = req.body?.minStrength ?? 0.3;
    try {
      res.json(await service.autoDiscoverRelations(minStrength));
    } catch (error) {
      next(error);
    }
  });

  // POST /api/memory/consolidate — merge near-duplicate memories
  router.post('/consolidate', requirePermission('write:governance'), async (__req, res, next) => {
    try {
      res.json(await service.consolidateMemories());
    } catch (error) {
      next(error);
    }
  });

  return router;
}
