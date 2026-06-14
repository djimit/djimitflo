/**
 * Agent routes
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { createError } from '../middleware/error-handler';
import type { AuthMiddleware } from '../middleware/auth';
import { AgentRegistryService } from '../services/agent-registry-service';

export function createAgentRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requireAuth = auth?.requireAuth ?? ((_req: any, _res: any, next: any) => next());
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const agentRegistry = new AgentRegistryService();

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
  
  // POST /api/agents/:id/heartbeat - Update agent heartbeat, metadata, and OKF concept
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

      // Write OKF agent concept + regenerate index
      try {
        agentRegistry.writeAgentConcept({
          id: agent.id,
          name: agent.name,
          description: agent.description || '',
          machineIp: agent.machine_ip || agent.metadata?.machine_ip || 'unknown',
          agentType: agent.agent_type || 'unknown',
          hostMachineId: agent.host_machine_id || agent.name,
          capabilities: JSON.parse(agent.capabilities || '[]'),
          lastSeen: now,
          status: status ?? agent.status,
          metadata: mergedMeta,
        });
        agentRegistry.regenerateIndex(
          db.prepare('SELECT * FROM agents WHERE last_heartbeat_at IS NOT NULL').all().map((a: any) => ({
            id: a.id,
            name: a.name,
            description: a.description || '',
            machineIp: a.machine_ip || 'unknown',
            agentType: a.agent_type || 'unknown',
            hostMachineId: a.host_machine_id || a.name,
            capabilities: JSON.parse(a.capabilities || '[]'),
            lastSeen: a.last_heartbeat_at || now,
            status: a.status,
            metadata: JSON.parse(a.metadata || '{}'),
          }))
        );
      } catch (okfErr: any) {
        console.warn(`OKF agent concept write failed for ${id}:`, okfErr?.message || okfErr);
      }

      res.json({ ok: true, agent_id: id, status: status ?? agent.status, last_heartbeat_at: now });
    } catch (error) {
      next(error);
    }
  });
  
  return router;
}