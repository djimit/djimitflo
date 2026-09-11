import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createCognitiveRoutes } from '../routes/cognitive';
import { errorHandler } from '../middleware/error-handler';
import { createTestDb } from './helpers/test-db';

describe('cognitive loop-closure HTTP chain', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it('records episodes, extracts patterns and evolves an advisory strategy', async () => {
    const db = createTestDb();
    dbs.push(db);
    const auth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use(express.json()).use(createCognitiveRoutes(db, auth)).use(errorHandler);

    expect((await request(app).post('/episodes').send({ outcome: 'success' })).status).toBe(400);
    expect((await request(app).get('/strategy/audit')).body.message).toContain('No learned strategy');

    for (const [index, outcome] of (['success', 'success', 'failure'] as const).entries()) {
      const response = await request(app).post('/episodes').send({
        loopRunId: `cognitive-fixture-${index}`, goalId: 'goal-fixture', goalType: 'audit', mode: 'closed',
        outcome, strategy: 'careful', durationMs: 100 + index, metrics: { totalCostDollars: 0.01 },
      });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ loopRunId: `cognitive-fixture-${index}`, goalType: 'audit', outcome });
    }

    const patterns = await request(app).post('/extract-patterns').send({});
    expect(patterns.status).toBe(200);
    expect(patterns.body.patternsExtracted).toBeGreaterThan(0);
    const evolved = await request(app).post('/evolve-strategies').send({});
    expect(evolved.status).toBe(200);
    expect(evolved.body.strategiesEvolved).toBeGreaterThanOrEqual(0);

    const strategy = await request(app).get('/strategy/audit');
    expect(strategy.status).toBe(200);
    expect(strategy.body).toMatchObject({ goalType: 'audit', successRate: expect.closeTo(2 / 3, 5), episodeCount: 3 });
    const stats = await request(app).get('/stats');
    expect(stats.status).toBe(200);
    expect(stats.body.totalEpisodes).toBe(3);
    expect((await request(app).get('/meta-learning')).body.records).toEqual(expect.arrayContaining([expect.objectContaining({ goalType: 'audit', totalEpisodes: 3 })]));
  });
});
