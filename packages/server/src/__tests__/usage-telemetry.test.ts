import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import express, { Router } from 'express';
import request from 'supertest';
import { UsageTelemetry } from '../services/usage-telemetry';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());

it('counts the matched route pattern (never ids, query strings or bodies) with its status class', async () => {
  const t = new UsageTelemetry(db, 0);
  const api = Router(); api.use(t.middleware());
  const goals = Router();
  goals.get('/:id', (_req, res) => { res.json({ ok: true }); });
  goals.post('/', (_req, res) => { res.status(400).json({}); });
  api.use('/goals', goals);
  const app = express(); app.use(express.json()); app.use('/api', api);
  await request(app).get('/api/goals/3f1c9a2e-secret?token=x');
  await request(app).get('/api/goals/other');
  await request(app).post('/api/goals').send({ secret: 'y' });
  await request(app).get('/api/nowhere');
  const rows = t.summary();
  expect(rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'api', name: '/api/goals/:id', method: 'GET', hits: 2, errors: 0 }),
    expect.objectContaining({ kind: 'api', name: '/api/goals', method: 'POST', hits: 1, errors: 1 }),
    expect.objectContaining({ kind: 'api', name: '(unmatched)', method: 'GET', hits: 1, errors: 1 }),
  ]));
  expect(JSON.stringify(db.prepare('SELECT * FROM usage_counts').all())).not.toMatch(/secret|token|3f1c9a2e/);
});

it('buffers counts and flushes them additively', () => {
  const t = new UsageTelemetry(db, 0);
  t.count('page', '/goals-loops'); t.count('page', '/goals-loops'); t.flush();
  t.count('page', '/goals-loops'); t.flush();
  expect(t.summary()).toEqual([expect.objectContaining({ kind: 'page', name: '/goals-loops', hits: 3 })]);
});
