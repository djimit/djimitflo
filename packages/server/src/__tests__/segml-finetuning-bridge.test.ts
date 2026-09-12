import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { UserRole } from '@djimitflo/shared';
import { SegmlFinetuningBridge } from '../services/segml-finetuning-bridge';
import { createSegmlFinetuningRoutes } from '../routes/segml-finetuning';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { errorHandler } from '../middleware/error-handler';
import { createTestDb } from './helpers/test-db';

describe('SegmlFinetuningBridge', () => {
  let db: Database.Database;
  let bridge: SegmlFinetuningBridge;

  beforeEach(() => {
    db = new Database(':memory:');
    bridge = new SegmlFinetuningBridge(db);
  });

  it('generates training data with synthetic pairs', () => {
    const dataset = bridge.generateTrainingData();
    expect(dataset.pairs.length).toBeGreaterThan(0);
    expect(dataset.categories.length).toBeGreaterThan(0);
    expect(dataset.totalWeight).toBeGreaterThan(0);
  });

  it('generates pairs for all governance categories', () => {
    const dataset = bridge.generateTrainingData();
    const categories = dataset.categories;
    expect(categories.length).toBeGreaterThanOrEqual(5);
  });

  it('caps pairs at maximum', () => {
    const dataset = bridge.generateTrainingData();
    expect(dataset.pairs.length).toBeLessThanOrEqual(500);
  });

  it('creates fine-tuning jobs', () => {
    const dataset = bridge.generateTrainingData();
    const job = bridge.createFinetuningJob(dataset.id, 'ollama-cloud/deepseek-v4-flash');
    expect(job.status).toBe('pending');
    expect(job.model).toBe('ollama-cloud/deepseek-v4-flash');
  });

  it('completes fine-tuning jobs', () => {
    const dataset = bridge.generateTrainingData();
    const job = bridge.createFinetuningJob(dataset.id, 'ollama-cloud/deepseek-v4-flash');
    bridge.completeFinetuningJob(job.id, { trainLoss: 0.5, evalLoss: 0.6 });

    const status = bridge.getStatus();
    expect(status.completedJobs).toBe(1);
  });

  it('fails closed when no provider-backed A/B evaluator is configured', () => {
    const dataset = bridge.generateTrainingData();
    expect(() => bridge.runABTest(dataset.id, 'baseline-model', 'finetuned-model')).toThrowError(
      expect.objectContaining({ code: 'SEGML_AB_TEST_UNAVAILABLE' }),
    );
    expect(bridge.getStatus().abTestsRun).toBe(0);
  });

  it('reports status', () => {
    const status = bridge.getStatus();
    expect(status.totalDatasets).toBe(0);
    expect(status.totalJobs).toBe(0);
  });

  it('returns a typed 503 instead of fabricated A/B scores over HTTP', async () => {
    const routeDb = createTestDb();
    try {
      const authService = new AuthService(routeDb);
      const user = authService.createUser('segml-ab@example.test', 'disposable-password', UserRole.ADMIN);
      const token = authService.generateToken(user);
      const auth = createAuthMiddleware(authService);
      const app = express().use(express.json()).use('/api/segml/finetuning', auth.requireAuth, createSegmlFinetuningRoutes(routeDb, auth)).use(errorHandler);
      const generated = await request(app).post('/api/segml/finetuning/generate').auth(token, { type: 'bearer' }).send({});
      expect(generated.status).toBe(200);
      expect(generated.body).toMatchObject({ datasetId: expect.any(String), pairs: expect.any(Number) });
      const datasetId = generated.body.datasetId;
      const trained = await request(app).post('/api/segml/finetuning/train').auth(token, { type: 'bearer' })
        .send({ datasetId, model: 'fixture-model' });
      expect(trained.status).toBe(200);
      expect(trained.body).toMatchObject({ datasetId, model: 'fixture-model', status: 'pending' });
      const status = await request(app).get('/api/segml/finetuning/status').auth(token, { type: 'bearer' });
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({ totalDatasets: 1, totalJobs: 1, completedJobs: 0, abTestsRun: 0 });
      const dataset = new SegmlFinetuningBridge(routeDb).generateTrainingData();
      const response = await request(app)
        .post('/api/segml/finetuning/ab-test')
        .set('Authorization', `Bearer ${token}`)
        .send({ datasetId: dataset.id, baselineModel: 'baseline-model', finetunedModel: 'finetuned-model' });
      expect(response.status).toBe(503);
      expect(response.body.error).toMatchObject({ code: 'SEGML_AB_TEST_UNAVAILABLE', status: 503 });
      expect(routeDb.prepare('SELECT COUNT(*) AS count FROM segml_ab_test_results').get()).toEqual({ count: 0 });
    } finally {
      routeDb.close();
    }
  });

  it('generates weighted pairs', () => {
    const dataset = bridge.generateTrainingData();
    for (const pair of dataset.pairs) {
      expect(pair.weight).toBeGreaterThan(0);
      expect(pair.weight).toBeLessThanOrEqual(1);
    }
  });
});
