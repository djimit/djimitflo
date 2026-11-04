import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSwarmIntelRoutes } from '../routes/swarm-intel';
import { errorHandler } from '../middleware/error-handler';
import { createTestDb } from './helpers/test-db';

describe('swarm intelligence plan and evolution contracts', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  const previousMode = process.env.SKILL_ARTIFACT_EVOLUTION_MODE;
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    if (previousMode === undefined) delete process.env.SKILL_ARTIFACT_EVOLUTION_MODE;
    else process.env.SKILL_ARTIFACT_EVOLUTION_MODE = previousMode;
  });

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
    // a manually reported outcome carries no skill delivery receipt (INT-004): stored and counted, never skill fitness
    expect(stats.body).toMatchObject({ avgFitness: null, topSkill: null });
  });

  it('exposes skill evolution inventory and validates candidate contracts before runtime use', async () => {
    process.env.SKILL_ARTIFACT_EVOLUTION_MODE = 'on';
    const instance = app();
    const inventory = await request(instance).get('/intelligence/skills/inventory');
    expect(inventory.status).toBe(200);
    expect(inventory.body.skills).toEqual(expect.any(Array));

    const missingCandidateFields = await request(instance).post('/intelligence/skills/candidates').send({ skill_id: 'unknown' });
    expect(missingCandidateFields.status).toBe(400);
    expect(missingCandidateFields.body.error.code).toBe('VALIDATION_ERROR');

    const badComparison = await request(instance).post('/intelligence/skills/candidates/missing/compare').send({ model: 'm', case_ids: [] });
    expect(badComparison.status).toBe(400);
  });

  it('answers every skill artifact evolution route as disabled without touching the DB while SKILL_ARTIFACT_EVOLUTION_MODE is off', async () => {
    delete process.env.SKILL_ARTIFACT_EVOLUTION_MODE;
    const instance = app();
    const prepare = vi.spyOn(dbs[0], 'prepare');
    const responses = [
      await request(instance).get('/intelligence/skills/inventory'),
      await request(instance).post('/intelligence/skills/candidates').send({ skill_id: 'unknown' }),
      await request(instance).get('/intelligence/skills/candidates/missing'),
      await request(instance).post('/intelligence/skills/candidates/missing/compare').send({ model: 'm', case_ids: ['a'] }),
      await request(instance).post('/intelligence/skills/candidates/missing/rollback'),
    ];
    for (const response of responses) {
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('SKILL_ARTIFACT_EVOLUTION_DISABLED');
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it('rate-limits the skill artifact evolution routes per router (30/min)', async () => {
    const instance = app();
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await request(instance).get('/intelligence/skills/inventory')).status);
    expect(statuses.slice(0, 30).every((status) => status !== 429)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});
