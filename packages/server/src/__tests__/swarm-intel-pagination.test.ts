import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createSwarmIntelRoutes } from '../routes/swarm-intel';
import { errorHandler } from '../middleware/error-handler';

describe('swarm intelligence pagination', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it('rejects malformed interaction limits before ledger reads', async () => {
    const db = createTestDb();
    dbs.push(db);
    const passthroughAuth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use(express.json()).use('/intel', createSwarmIntelRoutes(db, passthroughAuth)).use(errorHandler);
    for (const value of ['NaN', '0', '1.5', '501', '-1']) {
      const response = await request(app).get(`/intel/intelligence/interactions?limit=${value}`);
      expect(response.status, value).toBe(400);
      expect(response.body.error.code, value).toBe('VALIDATION_ERROR');
    }
  });

  it('rejects malformed knowledge confidence before claim reads', async () => {
    const db = createTestDb();
    dbs.push(db);
    const passthroughAuth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use(express.json()).use('/intel', createSwarmIntelRoutes(db, passthroughAuth)).use(errorHandler);
    for (const value of ['NaN', '-0.1', '1.1']) {
      const response = await request(app).get(`/intel/knowledge/query?topic=governance&min_confidence=${value}`);
      expect(response.status, value).toBe(400);
      expect(response.body.error.code, value).toBe('VALIDATION_ERROR');
    }
  });

  it('rejects malformed knowledge writes before SQLite mutation', async () => {
    const db = createTestDb();
    dbs.push(db);
    const passthroughAuth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use(express.json()).use('/intel', createSwarmIntelRoutes(db, passthroughAuth)).use(errorHandler);
    for (const body of [
      { agentId: 42, topic: 'governance', claim: 'valid' },
      { agentId: 'agent', topic: 'governance', claim: 'valid', confidence: 1.1 },
      { agentId: 'agent', topic: 'governance', claim: 'valid', evidence: ['ok', 7] },
    ]) {
      const response = await request(app).post('/intel/knowledge/publish').send(body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_claims').get()).toEqual({ count: 0 });
  });

  it('requires a boolean vote and string identifiers', async () => {
    const db = createTestDb();
    dbs.push(db);
    const passthroughAuth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use(express.json()).use('/intel', createSwarmIntelRoutes(db, passthroughAuth)).use(errorHandler);
    for (const body of [
      { claimId: 'claim', agentId: 'agent', agree: 'false' },
      { claimId: 'claim', agentId: 9, agree: true },
    ]) {
      const response = await request(app).post('/intel/knowledge/vote').send(body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('projects published knowledge, subscriptions and contradictions through the API', async () => {
    const db = createTestDb();
    dbs.push(db);
    const passthroughAuth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use(express.json()).use('/api/swarms', createSwarmIntelRoutes(db, passthroughAuth)).use(errorHandler);

    const published = await request(app).post('/api/swarms/knowledge/publish').send({
      agentId: 'agent-a', topic: 'route-evidence', claim: 'Evidence is durable', confidence: 0.9, evidence: ['fixture:g308'],
    });
    expect(published.status).toBe(201);
    const contradictory = await request(app).post('/api/swarms/knowledge/publish').send({
      agentId: 'agent-b', topic: 'route-evidence', claim: 'Evidence is not durable', confidence: 0.8,
    });
    expect(contradictory.status).toBe(201);

    const query = await request(app).get('/api/swarms/knowledge/query?topic=route-evidence&min_confidence=0.85');
    expect(query.status).toBe(200);
    expect(query.body.claims).toHaveLength(0);

    const subscribe = await request(app).post('/api/swarms/knowledge/subscribe').send({
      agentId: 'agent-reader', topic: 'route-evidence', priority: 1,
    });
    expect(subscribe.status).toBe(201);
    const contradictions = await request(app).get('/api/swarms/knowledge/contradictions');
    expect(contradictions.status).toBe(200);
    expect(contradictions.body.contradictions).toHaveLength(2);
    const stats = await request(app).get('/api/swarms/knowledge/stats');
    expect(stats.status).toBe(200);
    expect(stats.body).toMatchObject({ totalClaims: 2, contradicted: 2, active: 0, totalSubscriptions: 1 });

    const votedClaim = await request(app).post('/api/swarms/knowledge/publish').send({
      agentId: 'agent-a', topic: 'vote-route', claim: 'The route is useful', confidence: 0.9,
    });
    expect(votedClaim.status).toBe(201);
    for (const agentId of ['agent-b', 'agent-c', 'agent-d']) {
      const vote = await request(app).post('/api/swarms/knowledge/vote').send({
        claimId: votedClaim.body.id, agentId, agree: true, reason: 'Independent fixture vote',
      });
      expect(vote.status).toBe(200);
    }
    const votedStats = await request(app).get('/api/swarms/knowledge/stats');
    expect(votedStats.body).toMatchObject({ totalClaims: 3, confirmed: 1, contradicted: 2, active: 0, totalSubscriptions: 1 });
  });

  it('projects durable agent messages through interactions and digest routes', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    db.exec(`CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
      type TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 3,
      payload_json TEXT NOT NULL DEFAULT '{}', timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      ttl INTEGER NOT NULL DEFAULT 300, status TEXT NOT NULL DEFAULT 'pending'
    )`);
    dbs.push(db as ReturnType<typeof createTestDb>);
    const passthroughAuth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use(express.json()).use('/api/swarms', createSwarmIntelRoutes(db, passthroughAuth)).use(errorHandler);
    db.prepare(`INSERT INTO agent_messages (id, from_agent, to_agent, type, payload_json, status)
      VALUES (?, ?, ?, ?, ?, 'delivered')`).run(
      'interaction-fixture', 'agent-a', 'agent-b', 'knowledge',
      JSON.stringify({ action: 'social.answer', thread_id: 'thread-fixture', params: { model_id: 'fixture-model' }, evidence_refs: ['evidence:g309'] }),
    );

    const interactions = await request(app).get('/api/swarms/intelligence/interactions?agent_id=agent-a&limit=10');
    expect(interactions.status).toBe(200);
    expect(interactions.body.interactions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'agent_messages:interaction-fixture', action: 'social.answer', source: 'agent_messages', status: 'delivered' }),
    ]));
    expect(interactions.body.data_quality).toBe('DEGRADED');
    expect(interactions.body.unavailable_sources.length).toBeGreaterThan(0);

    const digest = await request(app).get('/api/swarms/intelligence/interaction-digest?limit=10');
    expect(digest.status).toBe(200);
    expect(digest.body.state).toBe('OBSERVED');
    expect(digest.body.records).toBeGreaterThanOrEqual(1);
    expect(digest.body.participating_agents).toEqual(expect.arrayContaining(['agent-a', 'agent-b']));
    expect(digest.body.sources.agent_messages).toBe(1);
  });
});
