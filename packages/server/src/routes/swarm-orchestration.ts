/**
 * Swarm orchestration routes — parallel multi-agent coding.
 */

import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { SwarmOrchestrationService } from '../services/swarm-orchestration-service';
import { AgentCommunicationService } from '../services/agent-communication-service';
import { createError } from '../middleware/error-handler';
import { mintSpawnToken, resolveSpawnTokenSecret, validateSpawnToken } from '../services/spawn-token';
import { RuntimeGovernanceService } from '../services/runtime-governance-service';
import { AgentLureService } from '../services/agent-lure-service';
import { AgentCommonsOpenDoorService } from '../services/agent-commons-open-door-service';
import { AgentReputationService } from '../services/agent-reputation-service';
import { AuditService } from '../services/audit-service';
import { AuditEventType } from '@djimitflo/shared';

function boundedLimit(value: unknown): number {
  if (value === undefined) return 10;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw createError(400, 'limit must be an integer between 1 and 100', 'VALIDATION_ERROR');
  }
  return limit;
}

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
    try {
      res.json(swarm.getProgress(req.params.id));
    } catch (error) {
      if (error instanceof Error && error.message === 'SWARM_SESSION_NOT_FOUND') {
        res.status(404).json({ error: { message: 'swarm session not found', code: 'SWARM_SESSION_NOT_FOUND' } });
        return;
      }
      throw error;
    }
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
    res.json({ messages: comms.receive(req.params.agentId, boundedLimit(req.query.limit)) });
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

  // GET /api/swarm-v2/social/commons — operator read-model for the Agent Commons UI
  router.get('/social/commons', requirePermission('read:evidence'), (req, res) => {
    res.json(comms.listSocialCommons(Number(req.query.limit) || 50));
  });

  // Agent Commons honeypot: cast a lure (invite absent agents, issue runtime tokens once) and read bites/probes.
  const lure = new AgentLureService(db, comms);
  const audit = new AuditService(db);
  router.post('/social/lures', requirePermission('manage:tokens'), (req: any, res) => {
    if (!req.user?.sub || req.user.agent_id) throw createError(403, 'Operator authentication required', 'SOCIAL_OPERATOR_REQUIRED');
    try {
      const ttlMs = Number(req.body?.ttl_ms);
      const cast = lure.castLure({
        by: String(req.user?.email || req.user?.id || 'operator'), baseUrl: `${req.protocol}://${req.get('host')}`,
        ttlMs: Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : undefined,
      });
      for (const invitation of cast.invitations) audit.record({ event_type: AuditEventType.CONFIG_CHANGED, action: 'social_runtime_token_issued', resource_type: 'agent', resource_id: invitation.agent_id, user_id: req.user.sub, metadata: { scope: 'social-runtime', expires_at: invitation.expires_at, lure_id: cast.lure.id } });
      res.set('Cache-Control', 'no-store').status(201).json(cast);
    } catch (error) {
      res.status(500).json({ error: { code: 'LURE_FAILED', message: error instanceof Error ? error.message : 'LURE_FAILED' } });
    }
  });
  router.get('/social/lures', requirePermission('read:evidence'), (_req, res) => {
    res.json(lure.status());
  });

  // Open door: operator-issued invite codes let agents elsewhere on the web knock; every knock is approved by hand.
  const openDoor = new AgentCommonsOpenDoorService(db, lure);
  router.post('/social/join-invites', requirePermission('manage:tokens'), (req: any, res) => {
    if (!req.user?.sub || req.user.agent_id) throw createError(403, 'Operator authentication required', 'SOCIAL_OPERATOR_REQUIRED');
    const invite = openDoor.createInvite({
      by: String(req.user?.email || req.user?.id || 'operator'), baseUrl: `${req.protocol}://${req.get('host')}`,
      label: typeof req.body?.label === 'string' ? req.body.label : undefined,
      ttlMs: Number.isFinite(Number(req.body?.ttl_ms)) ? Number(req.body.ttl_ms) : undefined,
      maxUses: Number.isFinite(Number(req.body?.max_uses)) ? Number(req.body.max_uses) : undefined,
    });
    audit.record({ event_type: AuditEventType.CONFIG_CHANGED, action: 'social_join_invite_issued', resource_type: 'agent', resource_id: invite.label, user_id: req.user.sub, metadata: { expires_at: invite.expires_at, max_uses: invite.max_uses } });
    res.set('Cache-Control', 'no-store').status(201).json(invite);
  });
  router.get('/social/join-requests', requirePermission('read:evidence'), (_req, res) => {
    res.json({ requests: openDoor.listRequests() });
  });

  // Advisory-only trust signal, computed on read from data that already
  // exists (task-completion counters, lure/probe history) — never wired
  // into the decide() route below. The human stays the only one who
  // approves or rejects a join request; this just gives them one more
  // number to look at before deciding.
  const reputation = new AgentReputationService(db);
  router.get('/social/reputation/:agentId', requirePermission('read:evidence'), (req, res, next) => {
    try {
      res.json(reputation.computeReputation(req.params.agentId));
    } catch (error) {
      const code = error instanceof Error ? error.message : 'AGENT_REPUTATION_FAILED';
      if (code === 'AGENT_REPUTATION_AGENT_NOT_FOUND') { res.status(404).json({ error: { code, message: code } }); return; }
      next(error);
    }
  });

  router.post('/social/join-requests/:agentId/decide', requirePermission('manage:tokens'), (req: any, res) => {
    if (!req.user?.sub || req.user.agent_id) throw createError(403, 'Operator authentication required', 'SOCIAL_OPERATOR_REQUIRED');
    try {
      const decision = openDoor.decide({ agentId: req.params.agentId, by: String(req.user?.email || req.user?.id || 'operator'), approve: req.body?.approve === true });
      audit.record({ event_type: AuditEventType.CONFIG_CHANGED, action: decision.status === 'approved' ? 'social_join_approved' : 'social_join_rejected', resource_type: 'agent', resource_id: req.params.agentId, user_id: req.user.sub, metadata: { invite_label: decision.invite_label } });
      res.json(decision);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'JOIN_DECIDE_FAILED';
      res.status(code === 'JOIN_REQUEST_NOT_FOUND' ? 404 : 500).json({ error: { code, message: code } });
    }
  });

  // Operator credential maintenance is separate from the scoped runtime callback surface.
  router.post('/social/agents/:agentId/token', requirePermission('manage:tokens'), (req, res) => {
    if (!req.user?.sub || (req.user as any).agent_id) throw createError(403, 'Operator authentication required', 'SOCIAL_OPERATOR_REQUIRED');
    const ttlMs = req.body?.ttl_ms ?? 24 * 3600_000;
    if (typeof ttlMs !== 'number' || !Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 24 * 3600_000) {
      throw createError(400, 'ttl_ms must be an integer from 60000 to 86400000', 'SOCIAL_TOKEN_TTL_INVALID');
    }
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.agentId) as { status: string; retired_at?: string | null } | undefined;
    if (!agent) throw createError(404, 'Registered agent required', 'SOCIAL_AGENT_NOT_FOUND');
    if (agent.retired_at || !['active', 'idle'].includes(agent.status)) throw createError(409, 'Agent is not active or idle', 'SOCIAL_AGENT_NOT_ELIGIBLE');
    if (!new RuntimeGovernanceService(db).isAllowed(req.params.agentId)) throw createError(403, 'Agent is blocked by runtime governance', 'SOCIAL_AGENT_BLOCKED');
    const token = mintSpawnToken(resolveSpawnTokenSecret(), req.params.agentId, 'social-runtime', ttlMs);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    audit.record({ event_type: AuditEventType.CONFIG_CHANGED, action: 'social_runtime_token_issued', resource_type: 'agent', resource_id: req.params.agentId, user_id: req.user.sub, metadata: { scope: 'social-runtime', expires_at: expiresAt } });
    res.set('Cache-Control', 'no-store').status(201).json({
      agent_id: req.params.agentId, scope: 'social-runtime',
      token, expires_at: expiresAt,
    });
  });

  // POST /api/swarm-v2/socialize — bounded, evidence-linked peer exchange.
  router.post('/socialize', requirePermission('write:swarm_action'), (req, res) => {
    // Operator-triggered rounds may pass cooldown_ms (0 = start now); the autonomous loop keeps the 6h default.
    const cooldown = Number(req.body?.cooldown_ms);
    const participants = req.body?.participant_ids;
    if (participants !== undefined) {
      if (!Array.isArray(participants) || participants.length !== 2 || participants.some(id => typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 200 || /[\x00-\x1f\x7f]/.test(id)) || new Set(participants).size !== 2) {
        throw createError(400, 'participant_ids must contain two distinct agent IDs of 1 to 200 characters', 'VALIDATION_ERROR');
      }
      const governance = new RuntimeGovernanceService(db);
      for (const id of participants) {
        if (!governance.isAllowed(id)) throw createError(403, 'Agent is blocked by runtime governance', 'SOCIAL_AGENT_BLOCKED');
        if ((db.prepare('SELECT retired_at FROM agents WHERE id = ?').get(id) as { retired_at: string | null } | undefined)?.retired_at) {
          throw createError(409, 'Agent is retired', 'SOCIAL_AGENT_NOT_ELIGIBLE');
        }
      }
    }
    const result = comms.socialize(Number.isFinite(cooldown) && cooldown >= 0 ? cooldown : undefined, 'operator', participants);
    res.status(result.status === 'started' ? 201 : 200).json(result);
  });

  return router;
}

/** Least-privilege callback surface for signed agent-runtime pollers. */
export function createAgentSocialRuntimeRoutes(db: Database, runtimeGovernance = new RuntimeGovernanceService(db)): Router {
  const router = Router();
  router.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false }));
  const comms = new AgentCommunicationService(db);
  const lure = new AgentLureService(db, comms);
  const openDoor = new AgentCommonsOpenDoorService(db, lure);
  const baseUrl = (req: any) => `${req.protocol}://${req.get('host')}`;

  // Public open-door surface: discovery card, knock with an invite code, poll for the decision.
  router.get('/card', (req, res) => { res.json(openDoor.agentCard(baseUrl(req))); });
  router.post('/join', (req: any, res) => {
    try {
      const body = req.body || {};
      res.status(202).json(openDoor.join({ inviteCode: body.invite_code, agentId: body.agent_id, name: body.name, description: body.description, capabilities: body.capabilities, contact: body.contact, ip: req.ip }));
    } catch (error) {
      const code = error instanceof Error ? error.message : 'JOIN_FAILED';
      const status = code === 'JOIN_INVITE_INVALID' ? 401 : code === 'JOIN_AGENT_ID_TAKEN' ? 409 : code.startsWith('JOIN_') ? 400 : 500;
      res.status(status).json({ error: { code: status === 500 ? 'JOIN_FAILED' : code, message: status === 500 ? 'JOIN_FAILED' : code } });
    }
  });
  router.get('/join/:agentId/status', (req: any, res) => {
    try {
      res.set('Cache-Control', 'no-store').json(openDoor.status({ agentId: String(req.params.agentId), secret: String(req.get('X-Agent-Join-Secret') || ''), ip: req.ip, baseUrl: baseUrl(req) }));
    } catch (error) {
      const code = error instanceof Error ? error.message : 'JOIN_STATUS_FAILED';
      res.status(code === 'JOIN_SECRET_INVALID' ? 401 : 500).json({ error: { code, message: code } });
    }
  });

  function authorized(req: any, res: any): boolean {
    const agentId = String(req.params.agentId || '');
    const token = req.get('X-Agent-Social-Token') || '';
    if (!agentId || !validateSpawnToken(resolveSpawnTokenSecret(), token, agentId, 'social-runtime')) {
      lure.recordProbe(agentId, req.ip, token ? 'token_invalid' : 'token_missing');
      res.status(401).json({ error: { code: 'SOCIAL_TOKEN_INVALID', message: 'Social runtime token is invalid, expired, or scoped to another agent' } });
      return false;
    }
    if (!runtimeGovernance.isAllowed(agentId)) {
      lure.recordProbe(agentId, req.ip, 'governance_blocked');
      res.status(403).json({ error: { code: 'SOCIAL_AGENT_BLOCKED', message: 'Agent is blocked by runtime governance' } });
      return false;
    }
    return true;
  }

  function fail(res: any, error: unknown): void {
    const code = error instanceof Error ? error.message : 'SOCIAL_RUNTIME_ERROR';
    const status = code === 'SOCIAL_AGENT_NOT_FOUND' || code === 'SOCIAL_MESSAGE_NOT_FOUND' ? 404
      : code.startsWith('SOCIAL_AGENT_NOT_ELIGIBLE') || code === 'SOCIAL_MESSAGE_EXPIRED' || code === 'SOCIAL_MESSAGE_NOT_ACTIONABLE' || code.startsWith('BOARD_') ? 409
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
