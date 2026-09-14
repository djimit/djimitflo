import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createSwarmRoutes } from '../routes/swarms';
import { errorHandler } from '../middleware/error-handler';
import { seedBenchmarkFixture } from '../services/expert-resolution-benchmark';

describe('frontier expert routes (§35: broad reads, governed mutation)', () => {
  let db: Database.Database;
  let app: express.Express;
  const user: Record<string, unknown> = { sub: 'op-1', email: 'operator@test' };

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    seedBenchmarkFixture(db);
    const auth = { requirePermission: () => (req: any, _res: any, next: any) => { req.user = user; next(); } } as any;
    app = express().use(express.json()).use('/swarms', createSwarmRoutes(db, auth)).use(errorHandler);
    delete process.env.DJIMITFLO_FRONTIER_EXPERTS_ENABLED;
  });
  afterEach(() => db.close());

  it('lists, filters and resolves experts with provenance, and validates input', async () => {
    const active = await request(app).get('/swarms/expert/experts?state=ACTIVE&capability=ai_security&limit=5');
    expect(active.status).toBe(200);
    expect(active.body.experts).toHaveLength(2);
    expect(active.body.experts[0].capabilities).toEqual(['ai_security']);
    expect((await request(app).get('/swarms/expert/experts?limit=0')).body.error.code).toBe('VALIDATION_ERROR');

    const resolved = await request(app).post('/swarms/expert/resolve').send({ question: 'Which prompt injection defences survive adaptive attackers?', max_experts: 2 });
    expect(resolved.status).toBe(200);
    expect(resolved.body.abstained).toBe(false);
    expect(resolved.body.experts[0].why_selected).toContain('ai_security');
    expect((await request(app).post('/swarms/expert/resolve').send({})).status).toBe(400);

    const detail = await request(app).get(`/swarms/expert/experts/${resolved.body.experts[0].expert_id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.expert.lifecycle_state).toBe('ACTIVE');
    expect(detail.body.provenance[0].evidence.length).toBeGreaterThan(0);
    expect(detail.body.lifecycle.map((event: { to_state: string }) => event.to_state)).toContain('ACTIVE');
    expect((await request(app).get('/swarms/expert/experts/expert:nope')).status).toBe(404);
  });

  it('offers bounded operator triggers for ingestion and enrichment', async () => {
    expect((await request(app).post('/swarms/expert/enrich').send({ limit: 50 })).body.error.code).toBe('VALIDATION_ERROR');
    user.agent_id = 'agent-1';
    expect((await request(app).post('/swarms/expert/ingest/pacing').send({})).status).toBe(403);
    delete user.agent_id;
    // No network in tests: mark every discovered identity as already attempted, so the bounded batch has nothing to fetch.
    db.prepare("UPDATE expert_identities SET provenance_json = json_set(provenance_json, '$.enrichment.attempted_at', '2026-09-01T00:00:00Z') WHERE lifecycle_state = 'DISCOVERED'").run();
    const enrich = await request(app).post('/swarms/expert/enrich').send({ limit: 2 });
    expect(enrich.status).toBe(200);
    expect(enrich.body).toEqual({ results: [], pending: 0 });
  });

  it('keeps lifecycle mutation governed: operator identity as actor, registry guards enforced, council flag-gated', async () => {
    const discovered = (await request(app).get('/swarms/expert/experts?state=DISCOVERED&limit=1')).body.experts[0];
    // A signature-only signatory cannot be promoted, whoever asks (I01).
    const blocked = await request(app).post(`/swarms/expert/experts/${discovered.id}/transition`).send({ to: 'ACTIVE' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('EXPERT_TRANSITION_INVALID');
    // Agents (tokens with agent_id) may not mutate the registry at all.
    user.agent_id = 'agent-1';
    expect((await request(app).post(`/swarms/expert/experts/${discovered.id}/transition`).send({ to: 'REJECTED' })).status).toBe(403);
    delete user.agent_id;
    const rejected = await request(app).post(`/swarms/expert/experts/${discovered.id}/transition`).send({ to: 'REJECTED', reason: 'duplicate' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.lifecycle_state).toBe('REJECTED');
    expect((db.prepare("SELECT actor FROM expert_lifecycle_events WHERE expert_id = ? AND to_state = 'REJECTED'").get(discovered.id) as { actor: string }).actor).toBe('operator@test');

    const off = await request(app).post('/swarms/expert/council').send({ topic: 'mechanistic interpretability of circuits' });
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('FRONTIER_EXPERTS_DISABLED');
    process.env.DJIMITFLO_FRONTIER_EXPERTS_ENABLED = 'true';
    const on = await request(app).post('/swarms/expert/council').send({ topic: 'mechanistic interpretability of circuits', max_experts: 2 });
    expect(on.status).toBe(200);
    // No model runtime configured: the council abstains loudly instead of inventing perspectives.
    expect(on.body.council).toMatchObject({ abstained: true, reason: 'FRONTIER_EXPERTS_RUNTIME_NOT_CONFIGURED' });
    expect(on.body.knowledge_updated).toBe(false);
    delete process.env.DJIMITFLO_FRONTIER_EXPERTS_ENABLED;
  });
});
