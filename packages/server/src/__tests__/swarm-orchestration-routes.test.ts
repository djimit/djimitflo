import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createSwarmOrchestrationRoutes } from '../routes/swarm-orchestration';
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
    const second = await request(app).post('/swarm/socialize');
    expect(second.status).toBe(200);
    expect(second.body.reason).toBe('cooldown_active');
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
