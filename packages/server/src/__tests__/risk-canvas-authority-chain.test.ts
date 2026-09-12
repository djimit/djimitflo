import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createAuthorityRoutes } from '../routes/authority';
import { createRiskRoutes } from '../routes/risk';
import { createCanvasRoutes } from '../routes/canvas';

const auth = {
  requirePermission: () => (req: any, _res: any, next: any) => {
    req.user = { sub: 'route-operator', email: 'operator@example.test', role: 'admin' };
    next();
  },
} as any;

describe('risk, canvas and authority route chains', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it('classifies risk, streams a canvas session and projects authority evidence', async () => {
    const db = createTestDb();
    dbs.push(db);
    db.exec(`
      CREATE TABLE authority_events (
        id TEXT PRIMARY KEY, event_id TEXT, correlation_id TEXT, sequence INTEGER,
        occurred_at TEXT, previous_state TEXT, requested_state TEXT, policy_decision TEXT,
        actor_subject TEXT, actor_type TEXT, actor_issuer TEXT, source_system TEXT
      );
    `);
    db.prepare(`INSERT INTO authority_events
      (id,event_id,correlation_id,sequence,occurred_at,previous_state,requested_state,policy_decision,actor_subject,actor_type,actor_issuer,source_system)
      VALUES ('authority-1','event-1','corr-1',1,datetime('now'),'pending','approved','ALLOW','route-operator','human','local','route-test')`).run();

    const app = express().use(express.json());
    app.use('/authority', createAuthorityRoutes(db, auth));
    app.use('/risk', createRiskRoutes(db, auth));
    app.use('/canvas', createCanvasRoutes(db, auth));

    const trace = await request(app).get('/authority/trace/corr-1');
    expect(trace.status).toBe(200);
    expect(trace.body).toMatchObject({ correlation_id: 'corr-1', summary: { event_count: 1, last_decision: 'ALLOW', last_state: 'approved' } });
    const stats = await request(app).get('/authority/stats');
    expect(stats.status).toBe(200);
    expect(stats.body.total).toBe(1);
    const events = await request(app).get('/authority/events?decision=ALLOW&limit=1');
    expect(events.status).toBe(200);
    expect(events.body).toMatchObject({ total: 1, events: [{ correlation_id: 'corr-1', policy_decision: 'ALLOW' }] });

    const command = await request(app).post('/risk/command').send({ command: 'echo hello' });
    expect(command.status).toBe(200);
    expect(command.body.assessment).toMatchObject({ risk_level: 'medium', recommended_decision: 'require_approval' });
    const task = await request(app).post('/risk/task').send({ task: { title: 'Read fixture', description: 'Inspect a local file' }, executorKind: 'codex' });
    expect(task.status).toBe(200);
    expect(task.body.assessment).toMatchObject({ action_type: 'task_execution', recommended_decision: expect.any(String) });

    const created = await request(app).post('/canvas/sessions').send({ runId: 'canvas-route-run' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ run_id: 'canvas-route-run' });
    const session = await request(app).get('/canvas/sessions/canvas-route-run');
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ status: 'active', messageCount: 0 });
    for (const [path, body] of [
      ['thinking', { content: 'reasoning' }],
      ['tool-call', { tool: 'read_file', args: { path: 'README.md' } }],
      ['tool-result', { tool: 'read_file', result: 'ok' }],
      ['diff', { filePath: 'README.md', diff: '+verified' }],
      ['progress', { current: 1, total: 2, label: 'halfway' }],
    ] as const) {
      const response = await request(app).post(`/canvas/sessions/canvas-route-run/${path}`).send(body);
      expect(response.status, path).toBe(200);
    }
    const completed = await request(app).post('/canvas/sessions/canvas-route-run/complete').send({ summary: 'done' });
    expect(completed.status).toBe(200);
    const listed = await request(app).get('/canvas/sessions');
    expect(listed.status).toBe(200);
    expect(listed.body.sessions[0]).toMatchObject({ runId: 'canvas-route-run', status: 'completed', messageCount: 6 });
  });
});
