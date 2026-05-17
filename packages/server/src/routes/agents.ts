/**
 * Agent routes
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { createError } from '../middleware/error-handler';

export function createAgentRoutes(db: Database): Router {
  const router = Router();
  
  // GET /api/agents - List all agents
  router.get('/', (_req, res, next) => {
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
  router.get('/:id', (req, res, next) => {
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
