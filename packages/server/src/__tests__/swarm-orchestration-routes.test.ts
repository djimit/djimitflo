import express from 'express';
import { ROLE_PERMISSIONS, UserRole } from '@djimitflo/shared';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createSwarmOrchestrationRoutes } from '../routes/swarm-orchestration';
import { mintSpawnToken, resolveSpawnTokenSecret, validateSpawnToken } from '../services/spawn-token';
import { RuntimeGovernanceService } from '../services/runtime-governance-service';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { errorHandler } from '../middleware/error-handler';

describe('swarm orchestration message pagination', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it('rejects malformed limits before the durable message query', async () => {
    const db = createTestDb();
    dbs.push(db);
    db.prepare("INSERT INTO agents (id, name) VALUES ('agent-a', 'Agent A')").run();
    const passthroughAuth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use(express.json()).use('/swarm', createSwarmOrchestrationRoutes(db, passthroughAuth)).use(errorHandler);
    for (const value of ['NaN', '0', '1.5', '101', '-1']) {
      const response = await request(app).get(`/swarm/messages/agent-a?limit=${value}`);
      expect(response.status, value).toBe(400);
      expect(response.body.error.code, value).toBe('VALIDATION_ERROR');
    }
    const valid = await request(app).get('/swarm/messages/agent-a?limit=1');
    expect(valid.status).toBe(200);
    expect(valid.body.messages).toEqual([]);
  });

  it('maps missing session progress to a typed 404', async () => {
    const db = createTestDb();
    dbs.push(db);
    const passthroughAuth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use('/swarm', createSwarmOrchestrationRoutes(db, passthroughAuth)).use(errorHandler);
    const response = await request(app).get('/swarm/sessions/missing-session/progress');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('SWARM_SESSION_NOT_FOUND');
  });

  it('starts one bounded social exchange only for the swarm-action permission', async () => {
    const db = createTestDb();
    dbs.push(db);
    const heartbeat = new Date().toISOString();
    db.prepare("INSERT INTO agents (id, name, status, metadata) VALUES ('agent-a', 'Agent A', 'active', ?), ('agent-b', 'Agent B', 'active', ?)")
      .run(JSON.stringify({ capabilities: ['review'], social_runtime: { enabled: true, last_heartbeat_at: heartbeat } }), JSON.stringify({ capabilities: ['build'], social_runtime: { enabled: true, last_heartbeat_at: heartbeat } }));
    const passthroughAuth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use(express.json()).use('/swarm', createSwarmOrchestrationRoutes(db, passthroughAuth)).use(errorHandler);
    const first = await request(app).post('/swarm/socialize');
    expect(first.status).toBe(201);
    expect(first.body.status).toBe('started');
    expect(first.body.messages).toHaveLength(2);
    expect(first.body.messages[0].payload.params).toMatchObject({ facilitator_trigger: 'operator', facilitated_by: 'operator-socialize-route' });
    const second = await request(app).post('/swarm/socialize');
    expect(second.status).toBe(200);
    expect(second.body.reason).toBe('cooldown_active');
  });

  it('scopes an operator round to the requested pair without bypassing auth or eligibility', async () => {
    const db = createTestDb(); dbs.push(db);
    db.prepare("INSERT INTO users (id,email,password_hash,role) VALUES ('operator','pair@test','unused','admin')").run();
    const service = new AuthService(db);
    const token = service.generateToken(service.findUserById('operator')!);
    const auth = createAuthMiddleware(service);
    const app = express().use(express.json()).use('/api/swarm-v2', auth.requireAuth, createSwarmOrchestrationRoutes(db, auth)).use(errorHandler);
    for (const id of ['agent-a', 'agent-b', 'agent-c']) db.prepare('INSERT INTO agents (id,name,status,metadata) VALUES (?, ?, ?, ?)').run(id, id, 'active', JSON.stringify({ social_runtime: { enabled: true, last_heartbeat_at: new Date().toISOString() } }));
    const round = (participant_ids: unknown) => request(app).post('/api/swarm-v2/socialize').set('Authorization', `Bearer ${token}`).send({ cooldown_ms: 0, participant_ids });
    for (const ids of [null, 'agent-a', [], ['agent-a'], ['agent-a', 'agent-a'], ['agent-a', 1], ['agent-a', ' '], ['agent-a', 'x'.repeat(201)], ['agent-a', 'agent-b', 'agent-c']]) {
      expect((await round(ids)).status).toBe(400);
    }
    const selected = await round(['agent-b', 'agent-c']);
    expect(selected.status).toBe(201);
    expect(selected.body.participants).toEqual(['agent-b', 'agent-c']);
    expect(selected.body.messages.every((message: { from: string; to: string }) => message.from !== 'agent-a' && message.to !== 'agent-a')).toBe(true);
    const socialToken = mintSpawnToken(resolveSpawnTokenSecret(), 'agent-b', 'social-runtime');
    expect((await request(app).post('/api/swarm-v2/socialize').set('X-Agent-Social-Token', socialToken).send({ participant_ids: ['agent-b', 'agent-c'] })).status).toBe(401);
    expect((await request(app).post('/api/swarm-v2/socialize').set('Authorization', `Bearer ${socialToken}`).send({ participant_ids: ['agent-b', 'agent-c'] })).status).toBe(401);
    db.prepare("UPDATE agents SET status = 'paused' WHERE id = 'agent-c'").run();
    expect((await round(['agent-b', 'agent-c'])).body.reason).toBe('insufficient_agents');
    db.prepare("UPDATE agents SET status = 'active', metadata = ? WHERE id = 'agent-c'").run(JSON.stringify({ social_runtime: { enabled: true, last_heartbeat_at: '2000-01-01T00:00:00Z' } }));
    expect((await round(['agent-b', 'agent-c'])).body.reason).toBe('insufficient_agents');
    const governance = new RuntimeGovernanceService(db);
    governance.registerBaseline('agent-c', { overallScore: 1, categoryScores: {}, certifiedAt: new Date().toISOString() });
    db.prepare("UPDATE runtime_governance_agents SET quarantined = 1 WHERE agent_id = 'agent-c'").run();
    expect((await round(['agent-b', 'agent-c'])).status).toBe(403);
    db.prepare("UPDATE agents SET retired_at = ? WHERE id = 'agent-b'").run(new Date().toISOString());
    expect((await round(['agent-a', 'agent-b'])).status).toBe(409);
  });

  it('renews only an eligible registered agent credential for an authorized operator', async () => {
    const db = createTestDb(); dbs.push(db);
    db.prepare("INSERT INTO users (id,email,password_hash,role) VALUES ('operator','operator@test','unused','admin')").run();
    db.prepare("INSERT INTO agents (id,name,status,metadata) VALUES ('present','Present','active',?),('idle','Idle','idle','{}'),('paused','Paused','paused','{}'),('blocked','Blocked','active','{}'),('retired','Retired','active','{}')")
      .run(JSON.stringify({ social_runtime: { enabled: true, last_heartbeat_at: new Date().toISOString() } }));
    db.prepare("UPDATE agents SET retired_at = ? WHERE id = 'retired'").run(new Date().toISOString());
    const governance = new RuntimeGovernanceService(db);
    governance.registerBaseline('blocked', { overallScore: 1, categoryScores: {}, certifiedAt: new Date().toISOString() });
    db.prepare("UPDATE runtime_governance_agents SET quarantined = 1 WHERE agent_id = 'blocked'").run();
    const auth = { requirePermission: (permission: string) => (req: any, res: any, next: any) => {
      expect(permission).toBe('manage:tokens');
      const role = req.get('Authorization') === 'Bearer test-maker' ? UserRole.MAKER : UserRole.ADMIN;
      if (!ROLE_PERMISSIONS[role].includes(permission) || req.get('Authorization') !== 'Bearer test-operator') { res.status(403).end(); return; }
      req.user = { sub: 'operator', ...(req.get('X-Test-Agent') ? { agent_id: 'present' } : {}) }; next();
    } } as any;
    const app = express().use(express.json()).use('/swarm', createSwarmOrchestrationRoutes(db, auth)).use(errorHandler);
    const renew = (agent: string, body: object = {}) => request(app).post(`/swarm/social/agents/${agent}/token`).set('Authorization', 'Bearer test-operator').send(body);
    for (const agent of ['present', 'idle']) {
      const response = await renew(agent, { ttl_ms: 60_000 });
      expect(response.status).toBe(201);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(validateSpawnToken(resolveSpawnTokenSecret(), response.body.token, agent, 'social-runtime')).toBe(true);
      expect(validateSpawnToken(resolveSpawnTokenSecret(), response.body.token, 'other-agent', 'social-runtime')).toBe(false);
      expect(validateSpawnToken(resolveSpawnTokenSecret(), response.body.token, agent, 'other-scope')).toBe(false);
      expect(Date.parse(response.body.expires_at) - Date.now()).toBeLessThanOrEqual(60_000);
      const event = db.prepare("SELECT user_id, resource_id, metadata FROM audit_events WHERE action = 'social_runtime_token_issued' AND resource_id = ?").get(agent) as any;
      expect(event).toMatchObject({ user_id: 'operator', resource_id: agent });
      expect(JSON.parse(event.metadata)).toEqual({ scope: 'social-runtime', expires_at: response.body.expires_at });
      expect(JSON.stringify(event)).not.toContain(response.body.token);
    }
    for (const [agent, code] of [['missing', 404], ['paused', 409], ['blocked', 403], ['retired', 409]] as const) expect((await renew(agent)).status).toBe(code);
    for (const ttl_ms of [0, 59_999, 86_400_001, '60000', 60_000.5]) expect((await renew('present', { ttl_ms })).status).toBe(400);
    for (const path of ['/swarm/social/agents/present/token', '/swarm/social/lures']) {
      expect((await request(app).post(path).set('Authorization', 'Bearer test-maker').send({ paperclip: false })).status).toBe(403);
    }
    const lure = await request(app).post('/swarm/social/lures').set('Authorization', 'Bearer test-operator').send({ paperclip: false });
    expect(lure.status).toBe(201);
    expect(lure.headers['cache-control']).toBe('no-store');
    for (const invitation of lure.body.invitations) {
      const event = db.prepare("SELECT metadata FROM audit_events WHERE action = 'social_runtime_token_issued' AND resource_id = ? ORDER BY rowid DESC LIMIT 1").get(invitation.agent_id) as any;
      expect(JSON.parse(event.metadata)).toMatchObject({ scope: 'social-runtime', lure_id: lure.body.lure.id, expires_at: invitation.expires_at });
      expect(JSON.stringify(event)).not.toContain(invitation.token);
    }
    const socialToken = mintSpawnToken(resolveSpawnTokenSecret(), 'present', 'social-runtime');
    expect((await request(app).post('/swarm/social/agents/present/token').set('X-Agent-Social-Token', socialToken).send({})).status).toBe(403);
    expect((await renew('present').set('X-Test-Agent', 'present')).status).toBe(403);
    expect(db.prepare("SELECT status FROM agents WHERE id = 'paused'").get()).toEqual({ status: 'paused' });
  });

  it('persists sessions and delivers durable messages with an idempotent replay', async () => {
    const db = createTestDb();
    dbs.push(db);
    db.prepare("INSERT INTO agents (id, name, status) VALUES ('agent-a', 'Agent A', 'idle'), ('agent-b', 'Agent B', 'idle')").run();
    const passthroughAuth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use(express.json()).use(createSwarmOrchestrationRoutes(db, passthroughAuth)).use(errorHandler);

    const created = await request(app).post('/sessions').send({ goal: 'build and verify a governed worker' });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('planning');
    expect(created.body.subtasks).toHaveLength(3);

    const listed = await request(app).get('/sessions');
    expect(listed.status).toBe(200);
    expect(listed.body.sessions).toEqual([expect.objectContaining({ id: created.body.id, progress: '0/3' })]);
    const progress = await request(app).get(`/sessions/${created.body.id}/progress`);
    expect(progress.status).toBe(200);
    expect(progress.body).toMatchObject({ sessionId: created.body.id, totalSubtasks: 3, pending: 3 });

    const unavailable = await request(app).post(`/sessions/${created.body.id}/execute`).send({});
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error.code).toBe('SWARM_RUNTIME_EXECUTOR_NOT_CONFIGURED');

    const messageBody = { from: 'agent-a', to: 'agent-b', type: 'task', action: 'inspect', params: { scope: 'fixture' }, idempotencyKey: 'swarm-route-fixture-1' };
    const sent = await request(app).post('/messages').send(messageBody);
    expect(sent.status).toBe(201);
    const replay = await request(app).post('/messages').send(messageBody);
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(sent.body.id);

    const received = await request(app).get('/messages/agent-b?limit=1');
    expect(received.status).toBe(200);
    expect(received.body.messages).toHaveLength(1);
    expect(received.body.messages[0]).toMatchObject({ id: sent.body.id, status: 'delivered' });
    const acknowledged = await request(app).post(`/messages/${sent.body.id}/acknowledge`).send({
      agentId: 'agent-b', leaseToken: received.body.messages[0].deliveryLeaseToken,
    });
    expect(acknowledged.status).toBe(200);
    expect(acknowledged.body).toEqual({ acknowledged: true });
    const stats = await request(app).get('/comms/stats');
    expect(stats.status).toBe(200);
    expect(stats.body).toMatchObject({ totalMessages: 1, deliveredMessages: 1, pendingMessages: 0 });
  });

  it('broadcasts through the canonical route only for the authenticated agent identity', async () => {
    const db = createTestDb();
    dbs.push(db);
    db.prepare("INSERT INTO agents (id, name, status) VALUES ('agent-a', 'Agent A', 'idle'), ('agent-b', 'Agent B', 'idle')").run();
    const auth = {
      requirePermission: () => (req: any, _res: any, next: any) => { req.user = { agent_id: 'agent-a' }; next(); },
    } as any;
    const app = express().use(express.json()).use('/api/swarm', createSwarmOrchestrationRoutes(db, auth)).use(errorHandler);

    const sent = await request(app).post('/api/swarm/broadcast').send({
      from: 'agent-a', type: 'task', action: 'inspect', params: { scope: 'fixture' },
      evidence: ['fixture-proof'], idempotencyKey: 'broadcast-route-fixture-1',
    });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ from: 'agent-a', to: 'broadcast', payload: { action: 'inspect' } });

    const replay = await request(app).post('/api/swarm/broadcast').send({
      from: 'agent-a', type: 'task', action: 'inspect', params: { scope: 'fixture' },
      evidence: ['fixture-proof'], idempotencyKey: 'broadcast-route-fixture-1',
    });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(sent.body.id);

    const forged = await request(app).post('/api/swarm/broadcast').send({ from: 'agent-b', action: 'forged' });
    expect(forged.status).toBe(403);
    expect(forged.body.error.code).toBe('BOARD_AGENT_PRINCIPAL_INVALID');
  });
});
