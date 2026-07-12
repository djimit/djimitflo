/**
 * Swarm orchestration routes — parallel multi-agent coding.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { SwarmOrchestrationService } from '../services/swarm-orchestration-service';
import { AgentCommunicationService } from '../services/agent-communication-service';

export function createSwarmOrchestrationRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const swarm = new SwarmOrchestrationService(db);
  const comms = new AgentCommunicationService(db);

  // GET /api/swarm/sessions — list active sessions
  router.get('/sessions', requirePermission('read:evidence'), (_req, res) => {
    res.json({ sessions: swarm.listSessions() });
  });

  // POST /api/swarm/sessions — create new swarm session
  router.post('/sessions', requirePermission('write:swarm_action'), (req, res) => {
    const { goal, maxAgents, priority } = req.body;
    if (!goal?.trim()) {
      res.status(400).json({ error: { message: 'goal is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const session = swarm.createSession(goal, { maxAgents, priority });
    res.status(201).json(session);
  });

  // POST /api/swarm/sessions/:id/execute — start execution
  router.post('/sessions/:id/execute', requirePermission('write:swarm_action'), (req, res) => {
    try {
      swarm.executeSession(req.params.id);
      res.json({ started: true, sessionId: req.params.id });
    } catch (error) {
      if (error instanceof Error && error.message === 'SWARM_RUNTIME_EXECUTOR_NOT_CONFIGURED') {
        res.status(503).json({ error: { code: error.message, message: 'No real swarm runtime executor is configured' } });
        return;
      }
      throw error;
    }
  });

  // GET /api/swarm/sessions/:id/progress — get progress
  router.get('/sessions/:id/progress', requirePermission('read:evidence'), (req, res) => {
    res.json(swarm.getProgress(req.params.id));
  });

  // ─── Agent Communication ──────────────────────────────────────────────
  // POST /api/swarm/messages — send message between agents
  router.post('/messages', requirePermission('write:swarm_action'), (req, res) => {
    const { from, to, type, priority, action, params, context, evidence, ttl } = req.body;
    if (!from || !to || !action) {
      res.status(400).json({ error: { message: 'from, to, and action are required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const message = comms.send({ from, to, type, priority, action, params, context, evidence, ttl });
    res.status(201).json(message);
  });

  // GET /api/swarm/messages/:agentId — receive messages for agent
  router.get('/messages/:agentId', requirePermission('read:evidence'), (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : 10;
    res.json({ messages: comms.receive(req.params.agentId, limit) });
  });

  // POST /api/swarm/messages/:id/acknowledge — acknowledge receipt
  router.post('/messages/:id/acknowledge', requirePermission('write:swarm_action'), (req, res) => {
    comms.acknowledge(req.params.id);
    res.json({ acknowledged: true });
  });

  // POST /api/swarm/broadcast — broadcast to all agents
  router.post('/broadcast', requirePermission('write:swarm_action'), (req, res) => {
    const { from, type, action, params, context, evidence } = req.body;
    const message = comms.broadcast({ from, type, action, params, context, evidence });
    res.status(201).json(message);
  });

  // GET /api/swarm/comms/stats — communication statistics
  router.get('/comms/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(comms.getStats());
  });

  return router;
}
