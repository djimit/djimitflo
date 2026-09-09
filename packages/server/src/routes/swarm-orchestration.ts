/**
 * Swarm orchestration routes — parallel multi-agent coding.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { SwarmOrchestrationService } from '../services/swarm-orchestration-service';
import { AgentCommunicationService } from '../services/agent-communication-service';
import { resolveSpawnTokenSecret, validateSpawnToken } from '../services/spawn-token';
import { RuntimeGovernanceService } from '../services/runtime-governance-service';

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

  // POST /api/swarm-v2/socialize — open a bounded, evidence-linked peer exchange
  router.post('/socialize', requirePermission('write:swarm_action'), (_req, res) => {
    const result = comms.socialize();
    res.status(result.status === 'started' ? 201 : 200).json(result);
  });

  return router;
}

/** Least-privilege callback surface for signed agent-runtime pollers. */
export function createAgentSocialRuntimeRoutes(
  db: Database,
  runtimeGovernance = new RuntimeGovernanceService(db),
): Router {
  const router = Router();
  const comms = new AgentCommunicationService(db);

  function authorized(req: any, res: any): boolean {
    const agentId = String(req.params.agentId || '');
    const token = req.get('X-Agent-Social-Token') || '';
    if (!agentId || !validateSpawnToken(resolveSpawnTokenSecret(), token, agentId, 'social-runtime')) {
      res.status(401).json({ error: { code: 'SOCIAL_TOKEN_INVALID', message: 'Social runtime token is invalid, expired, or scoped to another agent' } });
      return false;
    }
    if (!runtimeGovernance.isAllowed(agentId)) {
      res.status(403).json({ error: { code: 'SOCIAL_AGENT_BLOCKED', message: 'Agent is blocked by runtime governance' } });
      return false;
    }
    return true;
  }

  function fail(res: any, error: unknown): void {
    const code = error instanceof Error ? error.message : 'SOCIAL_RUNTIME_ERROR';
    const status = code === 'SOCIAL_AGENT_NOT_FOUND' || code === 'SOCIAL_MESSAGE_NOT_FOUND' ? 404
      : code === 'SOCIAL_MESSAGE_EXPIRED' || code === 'SOCIAL_MESSAGE_NOT_ACTIONABLE' ? 409
        : code.startsWith('SOCIAL_') && code.endsWith('_REQUIRED') ? 400 : 500;
    const safeCode = status === 500 ? 'SOCIAL_RUNTIME_ERROR' : code;
    res.status(status).json({ error: { code: safeCode, message: safeCode } });
  }

  router.post('/:agentId/heartbeat', (req, res) => {
    if (!authorized(req, res)) return;
    try { res.json(comms.heartbeat(req.params.agentId, req.body?.runtime, req.body?.model_id)); } catch (error) { fail(res, error); }
  });

  router.get('/:agentId/messages', (req, res) => {
    if (!authorized(req, res)) return;
    try { res.json({ messages: comms.receiveSocial(req.params.agentId, Number(req.query.limit) || 4) }); } catch (error) { fail(res, error); }
  });

  router.post('/:agentId/messages/:messageId/respond', (req, res) => {
    if (!authorized(req, res)) return;
    try {
      const result = comms.respondSocial(req.params.agentId, req.params.messageId, req.body || {});
      res.status(result.duplicate ? 200 : 201).json(result);
    } catch (error) { fail(res, error); }
  });

  return router;
}
