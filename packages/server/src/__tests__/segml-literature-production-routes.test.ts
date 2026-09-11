import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { UserRole } from '@djimitflo/shared';
import { createTestDb } from './helpers/test-db';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { createSegmlLiteratureRoutes } from '../routes/segml-literature';
import { createSegmlProductionRoutes } from '../routes/segml-production';

describe('SEGML literature and production HTTP contracts', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it('executes literature proposal flow and production dataset cycle with guarded provider actions', async () => {
    const db = createTestDb();
    dbs.push(db);
    const authService = new AuthService(db);
    const user = authService.createUser('segml-literature-production@example.test', 'disposable-password', UserRole.ADMIN);
    const token = authService.generateToken(user);
    const auth = createAuthMiddleware(authService);
    const app = express().use(express.json());
    app.use('/api/segml/literature', auth.requireAuth, createSegmlLiteratureRoutes(db, auth));
    app.use('/api/segml/production', auth.requireAuth, createSegmlProductionRoutes(db, auth));

    expect((await request(app).get('/api/segml/literature/status')).status).toBe(401);
    const scan = await request(app).post('/api/segml/literature/scan').set('Authorization', `Bearer ${token}`).send({});
    expect(scan.status).toBe(200);
    expect(scan.body.sourcesScanned).toBe(3);
    expect(scan.body.newCategoriesFound).toBeGreaterThan(0);

    const proposed = await request(app).get('/api/segml/literature/proposed').set('Authorization', `Bearer ${token}`);
    expect(proposed.status).toBe(200);
    expect(proposed.body.categories.length).toBeGreaterThan(0);
    const categoryId = proposed.body.categories[0].id;
    const approved = await request(app).post(`/api/segml/literature/approve/${categoryId}`).set('Authorization', `Bearer ${token}`).send({});
    expect(approved.status).toBe(200);
    expect(approved.body).toEqual({ approved: true });
    expect((await request(app).get('/api/segml/literature/proposed?status=invalid').set('Authorization', `Bearer ${token}`)).status).toBe(400);

    expect((await request(app).get('/api/segml/production/status').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    const generated = await request(app).post('/api/segml/production/generate').set('Authorization', `Bearer ${token}`).send({});
    expect(generated.status).toBe(200);
    expect(generated.body.examples).toBeGreaterThan(0);
    expect(generated.body.jsonlPath).toContain('.data/segml-training/');

    const cycle = await request(app).post('/api/segml/production/cycle').set('Authorization', `Bearer ${token}`).send({});
    expect(cycle.status).toBe(200);
    expect(cycle.body.deployed).toBe(false);
    expect((db.prepare('SELECT adapter_id FROM segml_prod_cycles ORDER BY completed_at DESC LIMIT 1').get() as { adapter_id: string | null }).adapter_id).toBeNull();
    expect((await request(app).post('/api/segml/production/train').set('Authorization', `Bearer ${token}`).send({ datasetId: 42 })).status).toBe(400);
    expect((await request(app).post('/api/segml/production/evaluate').set('Authorization', `Bearer ${token}`).send({ model: 'fixture', apiKey: 'key', categories: [] })).status).toBe(400);
    expect((await request(app).post('/api/segml/production/cycle').set('Authorization', `Bearer ${token}`).send({ apiKey: 42 })).status).toBe(400);
    const status = await request(app).get('/api/segml/production/status').set('Authorization', `Bearer ${token}`);
    expect(status.body.datasets).toBeGreaterThanOrEqual(2);
    expect(status.body.cycles).toBe(1);
  });
});
