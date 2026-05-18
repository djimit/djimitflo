/**
 * Agent routes
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { createError } from '../middleware/error-handler';
import type { AuthMiddleware } from '../middleware/auth';

export function createAgentRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requireAuth = auth?.requireAuth ?? ((_req: any, _res: any, next: any) => next());
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  // GET /api/agents - List all agents
  router.get('/', requireAuth, requirePermission('read:evidence'), (_req, res, next) => {
    try {
      const agents = db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all();
      
      const parsed = agents.map((agent: any) => ({
        ...agent,
        capabilities: JSON.parse(agent.capabilities || '[]'),
        metadata: JSON.parse(agent.metadata || '{}'),
      }));
      
      res.json({ agents: parsed });
    } catch (error) {
      next(error);
    }
  });
  
  // GET /api/agents/:id - Get agent by ID
  router.get('/:id', requireAuth, requirePermission('read:evidence'), (req, res, next) => {
    try {
      const { id } = req.params;
      const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as any;
      
      if (!agent) {
        throw createError(404, 'Agent not found', 'AGENT_NOT_FOUND');
      }
      
      res.json({
        ...agent,
        capabilities: JSON.parse(agent.capabilities || '[]'),
        metadata: JSON.parse(agent.metadata || '{}'),
      });
    } catch (error) {
      next(error);
    }
  });
  
  return router;
}