import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createTaskRoutes } from '../routes/tasks';
import { errorHandler } from '../middleware/error-handler';

// Truth audit 2026-11-12: prod held 1,462 tasks but GET /api/tasks reported total = page size (100).
let db: Database.Database;
let user: { sub: string; role: string };
const app = () => express()
  .use((req: any, _res, next) => { req.user = user; next(); })
  .use('/tasks', createTaskRoutes(db))
  .use(errorHandler);

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(schema);
  runMigrations(db);
  user = { sub: 'admin', role: 'admin' };
  const insert = db.prepare(`INSERT INTO tasks (id,title,description,status,priority,risk_level,execution_mode,metadata,created_by,owner_user_id,created_at)
    VALUES (?,?,?,?,'medium','low','review_only','{}',?,?,?)`);
  const statuses = [...Array(120).fill('completed'), ...Array(25).fill('failed'), ...Array(3).fill('cancelled'), ...Array(2).fill('paused')];
  statuses.forEach((status, i) => {
    const owner = i % 10 === 0 ? 'alice' : 'admin';
    insert.run(`task-${String(i).padStart(3, '0')}`, `Fixture ${i}${i === 7 ? ' needle' : ''}`, 'd'.repeat(13_000), status, owner, owner, new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString());
  });
});
afterEach(() => db.close());

it('returns the real total and per-status counts, not the page size', async () => {
  const res = await request(app()).get('/tasks');
  expect(res.status).toBe(200);
  expect(res.body.tasks).toHaveLength(100);
  expect(res.body.total).toBe(150);
  expect(res.body.counts).toEqual({ completed: 120, failed: 25, cancelled: 3, paused: 2 });
});

it('filters by status server-side and pages with offset/limit', async () => {
  const failed = await request(app()).get('/tasks?status=failed&limit=10&offset=20');
  expect(failed.body.total).toBe(25);
  expect(failed.body.tasks).toHaveLength(5);
  expect(failed.body.tasks.every((t: any) => t.status === 'failed')).toBe(true);
  // counts stay per status so the filter options can show their sizes
  expect(failed.body.counts.completed).toBe(120);
  const cancelled = await request(app()).get('/tasks?status=cancelled');
  expect(cancelled.body).toMatchObject({ total: 3 });
});

it('summary view omits full descriptions; search matches title or id', async () => {
  const res = await request(app()).get('/tasks?view=summary&limit=5');
  expect(res.body.tasks[0].description.length).toBeLessThan(400);
  expect(res.body.total).toBe(150);
  const full = await request(app()).get('/tasks?limit=1');
  expect(full.body.tasks[0].description).toHaveLength(13_000);
  const search = await request(app()).get('/tasks?q=needle');
  expect(search.body).toMatchObject({ total: 1, tasks: [{ id: 'task-007' }] });
});

it('totals respect task visibility for non-admins', async () => {
  user = { sub: 'alice', role: 'operator' };
  const res = await request(app()).get('/tasks');
  expect(res.body.total).toBe(15);
  expect(res.body.tasks).toHaveLength(15);
});
