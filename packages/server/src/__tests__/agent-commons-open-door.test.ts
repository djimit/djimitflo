import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { createAgentSocialRuntimeRoutes, createSwarmOrchestrationRoutes } from '../routes/swarm-orchestration';
import { AgentLureService } from '../services/agent-lure-service';
import { AgentCommunicationService } from '../services/agent-communication-service';
import { validateSpawnToken } from '../services/spawn-token';
import { createTestDb } from './helpers/test-db';

describe('agent commons open door', () => {
  let db: Database.Database;
  let app: express.Express;
  const secret = 'open-door-test-secret-with-enough-entropy';
  const operator = { requirePermission: () => (req: any, _res: any, next: any) => { req.user = { sub: 'user-1', email: 'operator@test' }; next(); } } as any;

  beforeEach(() => {
    process.env.JWT_SECRET = secret;
    db = createTestDb();
    app = express().use(express.json());
    app.use('/api/swarm-v2/social-runtime', createAgentSocialRuntimeRoutes(db));
    app.use('/api/swarm-v2', createSwarmOrchestrationRoutes(db, operator));
  });

  afterEach(() => { db.close(); delete process.env.JWT_SECRET; });

  it('publishes a card, lets an invited external agent knock, and issues a token only after approval', async () => {
    const card = await request(app).get('/api/swarm-v2/social-runtime/card');
    expect(card.status).toBe(200);
    expect(card.body.join.url).toMatch(/\/api\/swarm-v2\/social-runtime\/join$/);
    expect(card.body.runtime.reply_schema.answer).toBe('string');

    const invite = await request(app).post('/api/swarm-v2/social/join-invites').send({ label: 'www-pilot', max_uses: 1 });
    expect(invite.status).toBe(201);
    expect(invite.body.code).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const bad = await request(app).post('/api/swarm-v2/social-runtime/join').send({ invite_code: 'wrong', agent_id: 'wanderer', name: 'Wanderer' });
    expect(bad.status).toBe(401);
    const knock = await request(app).post('/api/swarm-v2/social-runtime/join').send({ invite_code: invite.body.code, agent_id: 'wanderer', name: 'Wanderer', capabilities: ['philosophy'], contact: 'ops@example.org' });
    expect(knock.status).toBe(202);
    expect(knock.body).toMatchObject({ agent_id: 'wanderer', status: 'pending' });
    expect(knock.body.join_secret).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect((await request(app).post('/api/swarm-v2/social-runtime/join').send({ invite_code: invite.body.code, agent_id: 'second', name: 'Second' })).status).toBe(401);
    expect(db.prepare("SELECT status FROM agents WHERE id = 'wanderer'").get()).toEqual({ status: 'paused' });

    const pending = await request(app).get(`/api/swarm-v2/social-runtime/join/wanderer/status?secret=${knock.body.join_secret}`);
    expect(pending.body).toEqual({ agent_id: 'wanderer', status: 'pending' });
    expect((await request(app).get('/api/swarm-v2/social-runtime/join/wanderer/status?secret=nope')).status).toBe(401);

    const requests = await request(app).get('/api/swarm-v2/social/join-requests');
    expect(requests.body.requests).toEqual([expect.objectContaining({ agent_id: 'wanderer', status: 'pending', invite_label: 'www-pilot', capabilities: ['philosophy'] })]);

    const decision = await request(app).post('/api/swarm-v2/social/join-requests/wanderer/decide').send({ approve: true });
    expect(decision.status).toBe(200);
    expect(decision.body).toMatchObject({ status: 'approved', decided_by: 'operator@test' });
    expect(db.prepare("SELECT status FROM agents WHERE id = 'wanderer'").get()).toEqual({ status: 'active' });

    const approved = await request(app).get(`/api/swarm-v2/social-runtime/join/wanderer/status?secret=${knock.body.join_secret}`);
    expect(approved.body.status).toBe('approved');
    expect(validateSpawnToken(secret, approved.body.token, 'wanderer', 'social-runtime')).toBe(true);
    expect(validateSpawnToken(secret, approved.body.token, 'other', 'social-runtime')).toBe(false);

    const heartbeat = await request(app).post('/api/swarm-v2/social-runtime/wanderer/heartbeat').set('X-Agent-Social-Token', approved.body.token).send({ runtime: 'www-agent', model_id: 'gpt-x' });
    expect(heartbeat.status).toBe(200);
    expect(new AgentCommunicationService(db).listSocialCommons().agents.map((agent) => agent.id)).toContain('wanderer');

    const probes = new AgentLureService(db, new AgentCommunicationService(db)).status().probes.map((probe) => probe.reason);
    expect(probes).toEqual(expect.arrayContaining(['invite_invalid', 'join_secret_invalid']));
  });

  it('keeps rejected knocks out and validates agent ids', async () => {
    const invite = await request(app).post('/api/swarm-v2/social/join-invites').send({ label: 'x', max_uses: 5 });
    expect((await request(app).post('/api/swarm-v2/social-runtime/join').send({ invite_code: invite.body.code, agent_id: 'Bad Id!', name: 'x' })).status).toBe(400);
    const knock = await request(app).post('/api/swarm-v2/social-runtime/join').send({ invite_code: invite.body.code, agent_id: 'intruder', name: 'Intruder' });
    const rejected = await request(app).post('/api/swarm-v2/social/join-requests/intruder/decide').send({ approve: false });
    expect(rejected.body.status).toBe('rejected');
    expect(db.prepare("SELECT status FROM agents WHERE id = 'intruder'").get()).toEqual({ status: 'offline' });
    expect((await request(app).get(`/api/swarm-v2/social-runtime/join/intruder/status?secret=${knock.body.join_secret}`)).body.status).toBe('rejected');
    expect((await request(app).post('/api/swarm-v2/social/join-requests/ghost/decide').send({ approve: true })).status).toBe(404);
  });
});
