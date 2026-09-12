import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createTaskRoutes } from '../routes/tasks';
import { errorHandler } from '../middleware/error-handler';

describe('task approval and cancellation routes', () => {
  let db: Database.Database;
  afterEach(() => db?.close());

  it('reads owned approvals and cancels only an actually running task', async () => {
    db = new Database(':memory:');
    db.exec(schema);
    runMigrations(db);
    db.prepare(`INSERT INTO tasks
      (id,title,description,status,priority,risk_level,execution_mode,metadata,created_by,owner_user_id)
      VALUES ('task-1','Cancellation fixture','run it','running','medium','low','local','{}','owner','owner')`).run();
    db.prepare(`INSERT INTO approvals
      (id,task_id,status,risk_level,request_type,request_message,request_data,metadata,requested_by)
      VALUES ('approval-1','task-1','pending','medium','shell_command','Needs review','{"command":"echo ok"}','{"source":"route-test"}','owner')`).run();

    let running = true;
    const engine = {
      isTaskRunning: (id: string) => id === 'task-1' && running,
      cancelTask: async (id: string) => {
        running = false;
        db.prepare("UPDATE tasks SET status='cancelled', updated_at=datetime('now') WHERE id=?").run(id);
      },
    } as any;
    const app = express()
      .use(express.json())
      .use((req: any, _res, next) => { req.user = { sub: 'owner', role: 'admin' }; next(); })
      .use('/tasks', createTaskRoutes(db, engine))
      .use(errorHandler);

    const approvals = await request(app).get('/tasks/task-1/approvals');
    expect(approvals.status).toBe(200);
    expect(approvals.body.approvals[0]).toMatchObject({ id: 'approval-1', request_data: { command: 'echo ok' }, metadata: { source: 'route-test' } });

    const cancelled = await request(app).post('/tasks/task-1/cancel');
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ task_id: 'task-1', message: 'Task cancelled' });
    expect((db.prepare('SELECT status FROM tasks WHERE id=?').get('task-1') as { status: string }).status).toBe('cancelled');

    const replay = await request(app).post('/tasks/task-1/cancel');
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe('TASK_NOT_RUNNING');
  });
});
