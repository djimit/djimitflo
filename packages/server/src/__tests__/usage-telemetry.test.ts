import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import express, { Router } from 'express';
import request from 'supertest';
import { MAX_BUFFERED_KEYS, UsageTelemetry } from '../services/usage-telemetry';

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

// OPS-003 (deep audit 2026-10-28): a failed flush used to drop the batch silently, so the summary under-reported usage with
// no marker. Rolled-back counts go back into the (bounded) buffer; what does not fit is counted, and the loss is labelled.
const failWrites = () => db.exec(`CREATE TRIGGER fail_usage BEFORE INSERT ON usage_counts BEGIN SELECT RAISE(ABORT, 'injected'); END`);
const healWrites = () => db.exec('DROP TRIGGER fail_usage');
const totalHits = (t: UsageTelemetry) => t.summary(1).reduce((n, r) => n + r.hits, 0);

it('a transient rollback keeps the batch: counts land exactly once after the database recovers', () => {
  const t = new UsageTelemetry(db, 0);
  t.count('page', '/a'); t.count('page', '/a'); t.count('api', '/api/x', 'GET', '2xx');
  failWrites();
  t.flush(); t.flush(); // two failed flushes must not duplicate the re-queued counts
  expect(t.summary()).toEqual([]);
  healWrites();
  t.count('page', '/a');
  expect(t.summary()).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'page', name: '/a', hits: 3 }),
    expect.objectContaining({ kind: 'api', name: '/api/x', hits: 1 }),
  ]));
  t.flush();
  expect(totalHits(t)).toBe(4);
  expect(t.coverage()).toEqual({ dropped_count: 0, incomplete: false });
});

it('a persistent failure keeps the buffer bounded, counts what it dropped, and labels the summary incomplete', () => {
  const t = new UsageTelemetry(db, 0);
  failWrites();
  t.count('page', '/p0'); t.flush();
  expect(t.coverage()).toEqual({ dropped_count: 0, incomplete: true }); // buffered but not yet persisted
  const extra = 7;
  for (let i = 0; i < MAX_BUFFERED_KEYS + extra; i++) { t.count('page', `/p${i}`); if (i % 2500 === 0) t.flush(); }
  t.count('page', '/p0'); // an already-buffered key still accumulates
  t.flush();
  expect(t.coverage()).toEqual({ dropped_count: extra, incomplete: true });
  healWrites();
  expect(totalHits(t)).toBe(MAX_BUFFERED_KEYS + 2); // stored + dropped = every count, none twice
  expect(t.coverage()).toEqual({ dropped_count: extra, incomplete: true }); // a known loss stays labelled
});
