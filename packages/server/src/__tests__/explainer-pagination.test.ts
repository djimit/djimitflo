import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createExplainerRoutes } from '../routes/explainer';
import { errorHandler } from '../middleware/error-handler';

describe('explainer pagination', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it('rejects malformed limits before explainer reads', async () => {
    const db = createTestDb();
    dbs.push(db);
    const auth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use('/explainer', createExplainerRoutes(db, auth)).use(errorHandler);
    for (const path of ['/explainer/tasks', '/explainer/fleet/repos', '/explainer/knowledge/search?q=governance', '/explainer/audit', '/explainer/fleet/calibration-sample']) {
      const response = await request(app).get(`${path}${path.includes('?') ? '&' : '?'}limit=NaN`);
      expect(response.status, path).toBe(400);
      expect(response.body.error.code, path).toBe('VALIDATION_ERROR');
    }
  });

  it('executes the canonical knowledge route chain with explicit empty/not-found states', async () => {
    const db = createTestDb();
    dbs.push(db);
    const auth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express()
      .use(express.json())
      .use('/api/explainer', createExplainerRoutes(db, auth))
      .use(errorHandler);

    expect((await request(app).post('/api/explainer/knowledge/sync').send({})).status).toBe(200);
    expect((await request(app).get('/api/explainer/knowledge/search?q=governance')).status).toBe(200);
    expect((await request(app).get('/api/explainer/knowledge/repos')).status).toBe(200);
    expect((await request(app).get('/api/explainer/knowledge/fact/missing')).status).toBe(404);
    expect((await request(app).get('/api/explainer/knowledge/manifest/acme/missing')).status).toBe(404);
    expect((await request(app).get('/api/explainer/fleet/overview')).status).toBe(200);
    expect((await request(app).get('/api/explainer/fleet/health-drift')).status).toBe(200);
    expect((await request(app).get('/api/explainer/fleet/calibration-sample')).status).toBe(200);
    expect((await request(app).get('/api/explainer/fleet/calibration-stats')).status).toBe(200);
    expect((await request(app).get('/api/explainer/audit')).status).toBe(200);
    expect((await request(app).get('/api/explainer/review-queue')).status).toBe(200);
    expect((await request(app).post('/api/explainer/fleet/kill-switch').send({ reason: 'fixture' })).status).toBe(200);
    expect((await request(app).post('/api/explainer/fleet/calibration-rate').send({ bundle_id: 'missing', rating: 80 })).status).toBe(404);
    expect((await request(app).post('/api/explainer/review-queue/missing/resolve').send({ resolution: 'approved' })).status).toBe(404);
  });

  it('executes grounded ask with validation and durable audit lineage', async () => {
    const db = createTestDb();
    dbs.push(db);
    const auth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use(express.json()).use('/api/explainer', createExplainerRoutes(db, auth)).use(errorHandler);

    expect((await request(app).post('/api/explainer/ask').send({ question: 'x' })).status).toBe(400);
    const response = await request(app).post('/api/explainer/ask').send({ question: 'What is governance?' }).expect(200);
    expect(response.body).toHaveProperty('refused');
    expect(db.prepare("SELECT action, outcome FROM explainer_audit_log WHERE action = 'ask_query'").all()).toHaveLength(1);
  });

  it('unpublishes a bundle and records the governance audit outcome', async () => {
    const db = createTestDb();
    dbs.push(db);
    db.prepare("INSERT INTO explainer_tasks (id, title, status, provider) VALUES ('task-unpublish', 'Fixture', 'completed', 'local')").run();
    db.prepare("INSERT INTO explainer_bundles (id, task_id, bundle_path, status) VALUES ('bundle-unpublish', 'task-unpublish', '/tmp/fixture', 'published')").run();
    const auth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use(express.json()).use('/api/explainer', createExplainerRoutes(db, auth)).use(errorHandler);
    const response = await request(app).post('/api/explainer/bundles/bundle-unpublish/unpublish').send({ reason: 'fixture withdrawal' }).expect(200);
    expect(response.body).toMatchObject({ id: 'bundle-unpublish', status: 'unpublished' });
    expect(db.prepare('SELECT status FROM explainer_bundles WHERE id = ?').get('bundle-unpublish')).toEqual({ status: 'unpublished' });
    expect(db.prepare("SELECT action, outcome FROM explainer_audit_log WHERE action = 'bundle_unpublish'").all()).toHaveLength(1);
  });
});
