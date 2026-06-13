/**
 * Agent routes — with POST /api/agents for swarm registration
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { createError } from '../middleware/error-handler';
import type { AuthMiddleware } from '../middleware/auth';
import { randomUUID } from 'crypto';

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

  // POST /api/agents - Create or upsert an agent (for swarm registration)
  router.post('/', requireAuth, requirePermission('manage:config'), (req, res, next) => {
    try {
      const {
        id,
        name,
        description,
        status = 'idle',
        capabilities = [],
        model,
        temperature = 0.7,
        max_tokens = 4096,
        metadata = {},
      } = req.body;

      if (!name || !description) {
        res.status(400).json({ error: { message: 'name and description are required', code: 'VALIDATION_ERROR' } });
        return;
      }

      const agentId = id || randomUUID();
      const now = new Date().toISOString();

      // Upsert: insert or replace
      db.prepare(`
        INSERT OR REPLACE INTO agents (
          id, name, description, status, capabilities, model, temperature, max_tokens,
          total_tasks, completed_tasks, failed_tasks, total_execution_time_ms, total_token_usage,
          last_active_at, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?, ?, COALESCE((SELECT created_at FROM agents WHERE id = ?), ?), ?)
      `).run(
        agentId, name, description, status, JSON.stringify(capabilities), model, temperature, max_tokens,
        now, JSON.stringify(metadata), agentId, now, now
      );

      const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as any;
      res.status(201).json({
        ...agent,
        capabilities: JSON.parse(agent.capabilities || '[]'),
        metadata: JSON.parse(agent.metadata || '{}'),
      });
    } catch (error) {
      next(error);
    }
  });

  // PATCH /api/agents/:id/status - Update agent status and stats
  router.patch('/:id/status', requireAuth, requirePermission('manage:config'), (req, res, next) => {
    try {
      const { id } = req.params;
      const { status, current_task_id, total_tasks, completed_tasks, failed_tasks, total_execution_time_ms, total_token_usage } = req.body;

      const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as any;
      if (!agent) {
        throw createError(404, 'Agent not found', 'AGENT_NOT_FOUND');
      }

      const updates: string[] = [];
      const values: any[] = [];

      if (status !== undefined) { updates.push('status = ?'); values.push(status); }
      if (current_task_id !== undefined) { updates.push('current_task_id = ?'); values.push(current_task_id); }
      if (total_tasks !== undefined) { updates.push('total_tasks = ?'); values.push(total_tasks); }
      if (completed_tasks !== undefined) { updates.push('completed_tasks = ?'); values.push(completed_tasks); }
      if (failed_tasks !== undefined) { updates.push('failed_tasks = ?'); values.push(failed_tasks); }
      if (total_execution_time_ms !== undefined) { updates.push('total_execution_time_ms = ?'); values.push(total_execution_time_ms); }
      if (total_token_usage !== undefined) { updates.push('total_token_usage = ?'); values.push(total_token_usage); }
      
      updates.push('last_active_at = ?');
      values.push(new Date().toISOString());
      updates.push('updated_at = ?');
      values.push(new Date().toISOString());
      values.push(id);

      db.prepare(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`).run(...values);

      const updated = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as any;
      res.json({
        ...updated,
        capabilities: JSON.parse(updated.capabilities || '[]'),
        metadata: JSON.parse(updated.metadata || '{}'),
      });
    } catch (error) {
      next(error);
    }
  });

  // DELETE /api/agents/:id - Remove an agent
  router.delete('/:id', requireAuth, requirePermission('manage:config'), (req, res, next) => {
    try {
      const { id } = req.params;
      const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as any;
      if (!agent) {
        throw createError(404, 'Agent not found', 'AGENT_NOT_FOUND');
      }
      db.prepare('DELETE FROM agents WHERE id = ?').run(id);
      res.json({ success: true, id });
    } catch (error) {
      next(error);
    }
  });
  
  return router;
}
