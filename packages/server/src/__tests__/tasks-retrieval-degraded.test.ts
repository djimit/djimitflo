import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createTaskRoutes } from '../routes/tasks';
import { errorHandler } from '../middleware/error-handler';
import { ContextInjectionService } from '../services/context-injection-service';

describe('task creation marks degraded context retrieval', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it('sets degraded=true + reason when injectContextSnapshot throws', async () => {
    // Force the first call to fail; fall through to a stubbed empty snapshot.
    const spy = vi.spyOn(ContextInjectionService.prototype, 'injectContextSnapshot');
    spy.mockRejectedValueOnce(new Error('qdrant unreachable'));
    spy.mockResolvedValue({ text: '', sha256: 'x'.repeat(64), sources: [] });

    const app = express();
    app.use(express.json());
    app.use('/tasks', createTaskRoutes(db));
    app.use(errorHandler);

    const res = await request(app).post('/tasks').send({ title: 't', description: 'd', use_swarm_context: true });
    expect(res.status).toBe(201);
    const snap = (res.body.metadata as any).context_snapshot;
    expect(snap.degraded).toBe(true);
    expect(snap.degraded_reason).toBe('qdrant unreachable');
    expect(snap.advisory).toBe(true);
  });

  it('sets degraded=false when retrieval succeeds', async () => {
    vi.spyOn(ContextInjectionService.prototype, 'injectContextSnapshot')
      .mockResolvedValue({ text: '', sha256: 'y'.repeat(64), sources: [] });
    const app = express();
    app.use(express.json());
    app.use('/tasks', createTaskRoutes(db));
    app.use(errorHandler);
    const res = await request(app).post('/tasks').send({ title: 't', description: 'd' });
    expect(res.status).toBe(201);
    expect((res.body.metadata as any).context_snapshot.degraded).toBe(false);
  });
});
