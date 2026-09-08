/**
 * Swarm orchestration routes — parallel multi-agent coding.
 */

import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { SwarmOrchestrationService } from '../services/swarm-orchestration-service';
import { AgentCommunicationService } from '../services/agent-communication-service';

export function createSwarmOrchestrationRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  // CodeQL js/missing-rate-limiting: session, communication and acknowledgement
  // handlers all access durable swarm state.
  router.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const swarm = new SwarmOrchestrationService(db);
  const comms = new AgentCommunicationService(db);
  const principalMatches = (req: any, agentId: string): boolean => {
    const principal = req.user?.agent_id;
    return !principal || principal === agentId;
  };

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
    const { from, to, type, priority, action, params, context, evidence, evidence_refs, evidenceRefs, ttl,
      threadId, thread_id, replyTo, reply_to, epistemicRole, epistemic_role, idempotencyKey, idempotency_key } = req.body;
    const normalizedEvidence = evidence ?? evidence_refs ?? evidenceRefs;
    const normalizedThreadId = threadId ?? thread_id;
    const normalizedReplyTo = replyTo ?? reply_to;
    const normalizedRole = epistemicRole ?? epistemic_role;
    const normalizedIdempotencyKey = idempotencyKey ?? idempotency_key;
    const normalizedFrom = typeof from === 'string' ? from.trim() : '';
    const normalizedTo = typeof to === 'string' ? to.trim() : '';
    if (!normalizedFrom || !normalizedTo || !action) {
      res.status(400).json({ error: { message: 'from, to, and action are required', code: 'VALIDATION_ERROR' } });
      return;
    }
    if (!db.prepare('SELECT 1 FROM agents WHERE id = ?').get(normalizedFrom)
      || !db.prepare('SELECT 1 FROM agents WHERE id = ?').get(normalizedTo)) {
      res.status(400).json({ error: { message: 'from and to must reference existing agents', code: 'BOARD_AGENT_NOT_FOUND' } });
      return;
    }
    if (!principalMatches(req, normalizedFrom)) {
      res.status(403).json({ error: { message: 'agent identity does not match authenticated principal', code: 'BOARD_AGENT_PRINCIPAL_INVALID' } });
      return;
    }
    try {
      const message = comms.send({ from: normalizedFrom, to: normalizedTo, type, priority, action, params, context, evidence: normalizedEvidence, ttl, threadId: normalizedThreadId, replyTo: normalizedReplyTo, epistemicRole: normalizedRole, idempotencyKey: normalizedIdempotencyKey });
      res.status(201).json(message);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('BOARD_')) {
        res.status(error.message === 'BOARD_IDEMPOTENCY_PAYLOAD_CONFLICT' ? 409 : 400).json({ error: { message: 'board message rejected by protocol', code: error.message } });
        return;
      }
      throw error;
    }
  });

  // GET /api/swarm/messages/:agentId — receive messages for agent
  router.get('/messages/:agentId', requirePermission('read:evidence'), (req, res) => {
    if (!principalMatches(req, req.params.agentId)) {
      res.status(403).json({ error: { message: 'message read identity does not match authenticated principal', code: 'BOARD_READ_PRINCIPAL_INVALID' } });
      return;
    }
    const limit = req.query.limit ? Number(req.query.limit) : 10;
    res.json({ messages: comms.receive(req.params.agentId, limit) });
  });

  // POST /api/swarm/messages/:id/acknowledge — acknowledge receipt
  router.post('/messages/:id/acknowledge', requirePermission('write:swarm_action'), (req, res) => {
    try {
      const agentId = typeof req.body?.agentId === 'string' ? req.body.agentId.trim() : '';
      const principal = (req.user as any)?.agent_id;
      if (principal && principal !== agentId) {
        res.status(403).json({ error: { message: 'acknowledgement identity does not match authenticated principal', code: 'BOARD_ACK_PRINCIPAL_INVALID' } });
        return;
      }
      const leaseToken = typeof req.body?.leaseToken === 'string' ? req.body.leaseToken.trim()
        : (typeof req.body?.lease_token === 'string' ? req.body.lease_token.trim() : undefined);
      comms.acknowledge(req.params.id, agentId || undefined, leaseToken);
      res.json({ acknowledged: true });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('BOARD_')) {
        res.status(400).json({ error: { message: 'board acknowledgement rejected by protocol', code: error.message } });
        return;
      }
      throw error;
    }
  });

  // POST /api/swarm/broadcast — broadcast to all agents
  router.post('/broadcast', requirePermission('write:swarm_action'), (req, res) => {
    const { from, type, action, params, context, evidence, evidence_refs, evidenceRefs, threadId, thread_id,
      replyTo, reply_to, epistemicRole, epistemic_role, idempotencyKey, idempotency_key } = req.body;
    const normalizedEvidence = evidence ?? evidence_refs ?? evidenceRefs;
    const normalizedThreadId = threadId ?? thread_id;
    const normalizedReplyTo = replyTo ?? reply_to;
    const normalizedRole = epistemicRole ?? epistemic_role;
    const normalizedIdempotencyKey = idempotencyKey ?? idempotency_key;
    const normalizedFrom = typeof from === 'string' ? from.trim() : '';
    if (!normalizedFrom || !action) {
      res.status(400).json({ error: { message: 'from and action are required', code: 'VALIDATION_ERROR' } });
      return;
    }
    if (!db.prepare('SELECT 1 FROM agents WHERE id = ?').get(normalizedFrom)) {
      res.status(400).json({ error: { message: 'from must reference an existing agent', code: 'BOARD_AGENT_NOT_FOUND' } });
      return;
    }
    if (!principalMatches(req, normalizedFrom)) {
      res.status(403).json({ error: { message: 'agent identity does not match authenticated principal', code: 'BOARD_AGENT_PRINCIPAL_INVALID' } });
      return;
    }
    try {
      const message = comms.broadcast({ from: normalizedFrom, type, action, params, context, evidence: normalizedEvidence, threadId: normalizedThreadId, replyTo: normalizedReplyTo, epistemicRole: normalizedRole, idempotencyKey: normalizedIdempotencyKey });
      res.status(201).json(message);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('BOARD_')) {
        res.status(400).json({ error: { message: 'board broadcast rejected by protocol', code: error.message } });
        return;
      }
      throw error;
    }
  });

  // GET /api/swarm/comms/stats — communication statistics
  router.get('/comms/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(comms.getStats());
  });

  return router;
}
