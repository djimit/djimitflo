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
  
  // POST /api/agents/:id/heartbeat - Update agent heartbeat and metadata
  router.post('/:id/heartbeat', requireAuth, requirePermission('write:evidence'), (req, res, next) => {
    try {
      const { id } = req.params;
      const { status, active_tasks, metadata } = req.body ?? {};
      const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as any;
      if (!agent) {
        throw createError(404, 'Agent not found', 'AGENT_NOT_FOUND');
      }

      const now = new Date().toISOString();
      const currentMeta = JSON.parse(agent.metadata || '{}');
      const mergedMeta = { ...currentMeta, ...(metadata || {}), active_tasks };

      db.prepare(
        `UPDATE agents SET status = COALESCE(?, status), metadata = ?, last_heartbeat_at = ? WHERE id = ?`
      ).run(status ?? agent.status, JSON.stringify(mergedMeta), now, id);

      res.json({ ok: true, agent_id: id, status: status ?? agent.status, last_heartbeat_at: now });
    } catch (error) {
      next(error);
    }
  });
  
  return router;
}