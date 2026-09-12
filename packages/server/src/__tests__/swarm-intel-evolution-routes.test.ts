import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createSwarmIntelRoutes } from '../routes/swarm-intel';
import { errorHandler } from '../middleware/error-handler';
import { createTestDb } from './helpers/test-db';

describe('swarm intelligence plan and evolution contracts', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  function app() {
    const db = createTestDb();
    dbs.push(db);
    const auth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    return express().use(express.json()).use(createSwarmIntelRoutes(db, auth)).use(errorHandler);
  }

  it('decomposes, persists and retrieves a multi-stage plan', async () => {
    const instance = app();
    for (const body of [
      {},
      { goal: 'build a verifier', maxParallelism: 0 },
      { goal: 'build a verifier', priority: 6 },
    ]) {
      const response = await request(instance).post('/decompose').send(body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }

    const created = await request(instance).post('/decompose').send({
      goal: 'build and test a governed verifier', maxParallelism: 2, priority: 2,
    });
    expect(created.status).toBe(201);
    expect(created.body.tasks).toHaveLength(2);
    expect(created.body.stages).toHaveLength(2);

    const listed = await request(instance).get('/plans');
    expect(listed.status).toBe(200);
    expect(listed.body.plans).toEqual([expect.objectContaining({ id: created.body.id, taskCount: 2 })]);

    const fetched = await request(instance).get(`/plans/${created.body.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body).toMatchObject({ id: created.body.id, goal: created.body.goal });
    expect((await request(instance).get('/plans/missing')).status).toBe(404);
  });

  it('records outcomes and produces a next skill generation', async () => {
    const instance = app();
    for (const body of [
      {},
      { skillId: 'invalid', traits: { reliability: 1.1 } },
      { skillId: 'invalid', traits: [] },
    ]) {
      const response = await request(instance).post('/evolution/register').send(body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }

    const first = await request(instance).post('/evolution/register').send({
      skillId: 'verifier-a', traits: { efficiency: 0.8, reliability: 0.8 },
    });
    const second = await request(instance).post('/evolution/register').send({
      skillId: 'verifier-b', traits: { efficiency: 0.6, reliability: 0.7 },
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    for (const skillId of ['verifier-a', 'verifier-b']) {
      const outcome = await request(instance).post('/evolution/outcome').send({
        skillId, success: true, tokensUsed: 400, durationMs: 120, domain: 'verification',
      });
      expect(outcome.status).toBe(200);
      expect(outcome.body).toEqual({ recorded: true });
    }

    const evolved = await request(instance).post('/evolution/evolve').send({});
    expect(evolved.status).toBe(200);
    expect(evolved.body.generation).toBe(2);
    expect(evolved.body.count).toBeGreaterThanOrEqual(1);

    const stats = await request(instance).get('/evolution/stats');
    expect(stats.status).toBe(200);
    expect(stats.body).toMatchObject({ currentGeneration: 2, totalOutcomes: 2 });
    expect(stats.body.totalGenomes).toBeGreaterThanOrEqual(3);
    expect(stats.body.topSkill).toBeTruthy();
  });
});
