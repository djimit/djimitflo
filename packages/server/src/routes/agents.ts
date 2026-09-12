/**
 * Agent routes — with POST /api/agents for swarm registration
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { createError } from '../middleware/error-handler';
import type { AuthMiddleware } from '../middleware/auth';
import { AgentRegistryService } from '../services/agent-registry-service';
import { NlAgentFactory } from '../services/nl-agent-factory';
import { randomUUID } from 'crypto';

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
      const existing = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as any;
      if (db.prepare('SELECT 1 FROM agents WHERE name = ? AND id <> ?').get(name, agentId)) {
        throw createError(409, 'Agent name belongs to a different identity', 'AGENT_NAME_CONFLICT');
      }
      if (!Array.isArray(capabilities) || capabilities.some(value => typeof value !== 'string')
        || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw createError(400, 'Invalid agent capabilities or metadata', 'VALIDATION_ERROR');
      }

      // Update in place: REPLACE deletes the identity and cascades into tasks,
      // messages and evidence. Registration never resets lifecycle or metrics.
      db.prepare(`
        INSERT INTO agents (
          id, name, description, status, capabilities, model, temperature, max_tokens,
          total_tasks, completed_tasks, failed_tasks, total_execution_time_ms, total_token_usage,
          last_active_at, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
          capabilities = excluded.capabilities, model = excluded.model, temperature = excluded.temperature,
          max_tokens = excluded.max_tokens, metadata = excluded.metadata, updated_at = excluded.updated_at
      `).run(
        agentId, name, description, existing?.status ?? status,
        req.body.capabilities === undefined && existing ? existing.capabilities : JSON.stringify(capabilities),
        req.body.model === undefined ? existing?.model ?? null : model,
        req.body.temperature === undefined ? existing?.temperature ?? temperature : temperature,
        req.body.max_tokens === undefined ? existing?.max_tokens ?? max_tokens : max_tokens,
        now, JSON.stringify({ ...JSON.parse(existing?.metadata || '{}'), ...metadata }), existing?.created_at ?? now, now
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

      if (agent.retired_at && status !== undefined && status !== 'offline') {
        throw createError(409, 'Retired agent identity cannot be reactivated by a status update', 'AGENT_RETIRED');
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
      if (agent.retired_at
        || db.prepare('SELECT 1 FROM tasks WHERE agent_id = ? LIMIT 1').get(id)
        || db.prepare('SELECT 1 FROM messages WHERE from_agent_id = ? OR to_agent_id = ? LIMIT 1').get(id, id)
        || db.prepare('SELECT 1 FROM audit_events WHERE agent_id = ? LIMIT 1').get(id)) {
        throw createError(409, 'Agent identity has retained work or audit history; retire it instead', 'AGENT_HAS_HISTORY');
      }
      db.prepare('DELETE FROM agents WHERE id = ?').run(id);
      res.json({ success: true, id });
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
      if ((metadata !== undefined && (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)))
        || (active_tasks !== undefined && (!Number.isInteger(active_tasks) || active_tasks < 0))) {
        throw createError(400, 'Invalid heartbeat telemetry', 'VALIDATION_ERROR');
      }
      // Evidence writers may report liveness, not approve/reactivate agents or
      // replace operator-owned configuration such as system_prompt and tools.
      const mergedMeta = { ...currentMeta, heartbeat: { reported_status: status, active_tasks, metadata: metadata || {} } };

      db.prepare(
        `UPDATE agents SET metadata = ?, last_heartbeat_at = ?, updated_at = ? WHERE id = ?`
      ).run(JSON.stringify(mergedMeta), now, now, id);

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
          status: agent.status,
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
        console.warn('OKF agent concept write failed:', id, okfErr?.message || okfErr);
      }

      res.json({ ok: true, agent_id: id, status: agent.status, last_heartbeat_at: now });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/agents/create-from-description — NL-driven agent creation
  router.post('/create-from-description', requireAuth, requirePermission('manage:config'), (req, res, next) => {
    try {
      const { description, name, model, temperature, max_tokens } = req.body;

      if (!description?.trim()) {
        res.status(400).json({ error: { message: 'description is required', code: 'VALIDATION_ERROR' } });
        return;
      }

      const factory = new NlAgentFactory(db);
      const result = factory.createFromDescription(description, { name, model, temperature, max_tokens });

      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/agents/:id/approve — approve a pending NL-generated agent
  router.post('/:id/approve', requireAuth, requirePermission('manage:config'), (req, res, next) => {
    try {
      const factory = new NlAgentFactory(db);
      factory.approveAgent(req.params.id);

      const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as any;
      res.json({
        ...agent,
        capabilities: JSON.parse(agent.capabilities || '[]'),
        metadata: JSON.parse(agent.metadata || '{}'),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'AGENT_NOT_FOUND') {
        next(createError(404, 'Agent not found', 'AGENT_NOT_FOUND'));
        return;
      }
      if (error instanceof Error && error.message === 'AGENT_NOT_PENDING') {
        next(createError(409, 'Agent is not pending approval', 'AGENT_NOT_PENDING'));
        return;
      }
      next(error);
    }
  });

  return router;
}
