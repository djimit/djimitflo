import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApexRoutes } from '../routes/apex';
import { errorHandler } from '../middleware/error-handler';
import { createTestDb } from './helpers/test-db';

describe('apex inventory and unavailable-runtime contracts', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it('exposes durable inventory/status and fails closed for plugin activation', async () => {
    const db = createTestDb();
    dbs.push(db);
    const auth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use(express.json()).use(createApexRoutes(db, auth, false)).use(errorHandler);

    const plugins = await request(app).get('/plugins');
    expect(plugins.status).toBe(200);
    expect(plugins.body.plugins).toEqual([]);
    const pluginStats = await request(app).get('/plugins/stats');
    expect(pluginStats.status).toBe(200);
    expect(pluginStats.body).toMatchObject({ totalPlugins: 0, enabledPlugins: 0, totalTools: 0 });

    for (const action of ['enable', 'disable']) {
      const response = await request(app).post(`/plugins/fixture-plugin/${action}`).send({});
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe('PLUGIN_ACTIVATION_UNAVAILABLE');
    }

    const clusters = await request(app).get('/memory/clusters');
    expect(clusters.status).toBe(200);
    expect(clusters.body).toEqual({ clusters: [] });
    const memoryStats = await request(app).get('/memory/stats');
    expect(memoryStats.status).toBe(200);
    expect(memoryStats.body).toMatchObject({ totalMemories: 0, feedbackCount: 0 });

    const workers = await request(app).get('/workers/status');
    expect(workers.status).toBe(200);
    expect(workers.body.workers.length).toBeGreaterThan(0);
    expect(workers.body.workers.every((worker: any) => worker.running === false)).toBe(true);

    expect((await request(app).post('/memory/store').send({})).status).toBe(400);
    expect((await request(app).get('/memory/search?limit=0&q=fixture')).status).toBe(400);
  });
});
