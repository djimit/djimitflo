import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDb } from './helpers/test-db';
import { createLearningRoutes } from '../routes/learning';
import { errorHandler } from '../middleware/error-handler';

describe('learning cognitive integration', () => {
  it('extracts cognitive patterns after persisting a learning', () => {
    const db = createTestDb();
    const extractPatterns = vi.fn(() => [{ id: 'pattern-1' }]);
    const router = createLearningRoutes(db, undefined, { extractPatterns } as any);
    const layer = router.stack.find((entry: any) => entry.route?.path === '/' && entry.route.methods.post);
    const handler = layer.route.stack.at(-1).handle;
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();

    handler({ body: { title: 'Reusable lesson' } }, { status, json }, vi.fn());

    expect(extractPatterns).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledWith(201);
    expect(json.mock.calls[0][0].patterns).toEqual([{ id: 'pattern-1' }]);
    db.close();
  });

  it('projects learning create, list and detail through authenticated route paths', async () => {
    const db = createTestDb();
    const auth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use(express.json()).use('/api/learning', createLearningRoutes(db, auth)).use(errorHandler);
    const created = await request(app).post('/api/learning').send({
      id: 'learning-route-proof', category: 'optimization', title: 'Route projection lesson',
      description: 'Persisted learning remains queryable.', lesson_learned: 'Read paths must project durable lessons.',
      effectiveness: 88, times_applied: 2,
    });
    expect(created.status).toBe(201);
    expect(created.body.learning).toMatchObject({ id: 'learning-route-proof', category: 'optimization', effectiveness: 88, times_applied: 2 });
    const list = await request(app).get('/api/learning');
    expect(list.status).toBe(200);
    expect(list.body.learnings).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'learning-route-proof' })]));
    const detail = await request(app).get('/api/learning/learning-route-proof');
    expect(detail.status).toBe(200);
    expect(detail.body.learning).toMatchObject({ id: 'learning-route-proof', lesson_learned: 'Read paths must project durable lessons.' });
    db.close();
  });
});
