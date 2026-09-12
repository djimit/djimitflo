import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createTaskRoutes } from '../routes/tasks';
import { errorHandler } from '../middleware/error-handler';
import { ContextInjectionService } from '../services/context-injection-service';

describe('task context reaches the durable executor input', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    // Retrieval is deliberately exercised through the local fallback. Remote
    // stores are unavailable in this proof and must remain non-blocking.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    new ContextInjectionService(db);
    db.prepare(`INSERT INTO experience_embeddings
      (run_id, objective, outcome, retries, runtime, capability_id, lessons, total_tokens)
      VALUES ('episode-context', 'Fix context execution chain', 'success', 1, 'codex', 'context-proof', ?, 1200)`)
      .run(JSON.stringify(['preserve the exact input snapshot']));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });

  it('persists one advisory snapshot and appends the same text to task.description', async () => {
    const app = express();
    app.use(express.json());
    app.use('/tasks', createTaskRoutes(db));
    app.use(errorHandler);

    const response = await request(app).post('/tasks').send({
      title: 'Context execution',
      description: 'Validate context chain',
      use_swarm_context: true,
    });
    expect(response.status).toBe(201);

    const task = response.body;
    const metadata = task.metadata as Record<string, any>;
    expect(task.description).toContain('## Past Experience (advisory observed episodes)');
    expect(task.description).toContain('Source class: observed_episode; independently reviewed: no');
    expect(task.description).toContain('loop:episode-context');
    expect(metadata.context_snapshot).toMatchObject({
      advisory: true,
      independently_reviewed: false,
      sources: ['experience_retrieval'],
    });

    const context = task.description.slice('Validate context chain\n\n'.length);
    expect(metadata.swarm_context).toBe(context);
    expect(metadata.context_snapshot.sha256).toBe(createHash('sha256').update(context).digest('hex'));

    // Restart-equivalent retrieval produces the same bounded snapshot hash.
    const replay = await new ContextInjectionService(db).injectContextSnapshot('Context execution Validate context chain', true);
    expect(replay.text).toBe(context);
    expect(replay.sha256).toBe(metadata.context_snapshot.sha256);
  });
});
