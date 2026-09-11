import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createMemoryRoutes } from '../routes/memory';
import { errorHandler } from '../middleware/error-handler';

describe('proactive memory route chain', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it('stores, accesses, relates and maintains memories with durable statistics', async () => {
    const db = createTestDb();
    dbs.push(db);
    const auth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use(express.json()).use('/memory', createMemoryRoutes(db, auth)).use(errorHandler);

    const first = await request(app).post('/memory/store').send({ content: 'governed routing evidence', type: 'observation', metadata: { source: 'route-test' } });
    const second = await request(app).post('/memory/store').send({ content: 'governed routing verification', type: 'observation' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const malformedRelation = await request(app).post('/memory/relations').send({ sourceId: first.body.id, targetId: second.body.id, strength: 2 });
    expect(malformedRelation.status).toBe(400);
    expect(malformedRelation.body.error.code).toBe('VALIDATION_ERROR');

    const relation = await request(app).post('/memory/relations').send({ sourceId: first.body.id, targetId: second.body.id, relationType: 'supports', strength: 0.8 });
    expect(relation.status).toBe(201);
    expect(relation.body).toMatchObject({ sourceId: first.body.id, targetId: second.body.id, relationType: 'supports', strength: 0.8 });

    const accessed = await request(app).get(`/memory/${first.body.id}`);
    expect(accessed.status).toBe(200);
    expect(accessed.body).toMatchObject({ id: first.body.id, usageCount: 1, metadata: { source: 'route-test' } });
    const related = await request(app).get(`/memory/${first.body.id}/related`);
    expect(related.status).toBe(200);
    expect(related.body.related[0]).toMatchObject({ id: second.body.id, relationType: 'supports', strength: 0.8 });

    const maintenance = await request(app).post('/memory/maintenance').send({});
    expect(maintenance.status).toBe(200);
    expect(maintenance.body.evaluated).toBe(2);
    for (let i = 0; i < 5; i++) expect((await request(app).get(`/memory/${first.body.id}`)).status).toBe(200);
    const promote = await request(app).post('/memory/maintenance').send({});
    expect(promote.status).toBe(200);
    const top = await request(app).get('/memory/top?limit=5&type=observation');
    expect(top.status).toBe(200);
    expect(top.body.memories[0]).toMatchObject({ id: first.body.id, status: 'active' });
    const discovered = await request(app).post('/memory/discover-relations').send({ minStrength: 0.3 });
    expect(discovered.status).toBe(200);
    expect(discovered.body).toHaveProperty('discovered');
    const duplicateA = await request(app).post('/memory/store').send({ content: 'duplicate consolidation fixture', type: 'observation' });
    const duplicateB = await request(app).post('/memory/store').send({ content: 'duplicate consolidation fixture', type: 'observation' });
    expect(duplicateA.status).toBe(201);
    expect(duplicateB.status).toBe(201);
    const consolidated = await request(app).post('/memory/consolidate').send({});
    expect(consolidated.status).toBe(200);
    expect(consolidated.body).toMatchObject({ merged: 1, removed: [duplicateB.body.id] });
    const stats = await request(app).get('/memory/stats');
    expect(stats.status).toBe(200);
    expect(stats.body).toMatchObject({ total: 3, active: 1, candidates: 2, totalRelations: 1 });
    expect((db.prepare('SELECT COUNT(*) AS count FROM proactive_memories').get() as { count: number }).count).toBe(3);
  });
});
