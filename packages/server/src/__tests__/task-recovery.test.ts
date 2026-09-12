import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ExecutionEngine } from '../execution/execution-engine';
import { MockExecutor } from '../execution/executors/mock-executor';
import { createTaskRoutes } from '../routes/tasks';
import { errorHandler } from '../middleware/error-handler';
import { runtimeConcurrencySemaphore } from '../services/concurrency-semaphore';
import { LoopWorkerExecutorService } from '../services/loop-worker-executor-service';

describe('startup task recovery without external replay', () => {
  let db: Database.Database;
  let engine: ExecutionEngine;
  let app: express.Express;
  const ws = { broadcastTaskEvent: vi.fn(), broadcastTaskEventById: vi.fn() };
  const insert = (id: string, status = 'running', metadata: unknown = {}) => db.prepare(`INSERT INTO tasks
    (id,title,description,status,priority,risk_level,execution_mode,metadata,created_by,owner_user_id)
    VALUES (?, 'Recovery fixture', 'echo hello', ?, 'low', 'low', 'local', ?, 'owner', 'owner')`)
    .run(id, status, typeof metadata === 'string' ? metadata : JSON.stringify(metadata));
  const row = (id: string) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;

  beforeEach(() => {
    db = new Database(':memory:'); db.exec(schema); runMigrations(db);
    engine = new ExecutionEngine(db, ws as any);
    app = express(); app.use(express.json());
    app.use((req: any, _res, next) => { req.user = { sub: 'owner', role: 'admin' }; next(); });
    app.use('/tasks', createTaskRoutes(db, engine, undefined, ws as any)); app.use(errorHandler);
  });
  afterEach(() => {
    for (const task of db.prepare('SELECT id FROM tasks').all() as Array<{ id: string }>) runtimeConcurrencySemaphore.release(`execution:${task.id}`);
    vi.restoreAllMocks(); db.close();
  });

  it('holds unknown, malformed and user-forged runtime provenance idempotently; leaves ordinary queued and terminal tasks alone', () => {
    insert('unknown'); insert('malformed', 'running', '{bad json');
    insert('forged', 'running', { execution_recovery_attempt: { executorKind: 'mock', inProcess: true }, executor: 'mock' });
    insert('queued', 'queued'); insert('done', 'completed');
    expect(engine.recoverInterruptedTasks()).toEqual({ failedMockTasks: 0, heldTasks: 3 });
    for (const id of ['unknown', 'malformed', 'forged']) {
      expect(row(id).status).toBe('paused');
      expect(JSON.parse(row(id).metadata)).toMatchObject({ execution_recovery_hold: true, execution_recovery_outcome: 'unknown' });
      expect(db.prepare('SELECT COUNT(*) AS n FROM execution_evidence WHERE task_id = ?').get(id)).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE task_id = ?').get(id)).toEqual({ n: 1 });
    }
    expect(row('queued').status).toBe('queued'); expect(row('done').status).toBe('completed');
    expect(engine.recoverInterruptedTasks()).toEqual({ failedMockTasks: 0, heldTasks: 0 });
  });

  it.each(['pending', 'queued'])('stamps actual attempt before start and safely fails only a confirmed in-process mock from %s after ownership loss', async initialStatus => {
    insert('mock-task', initialStatus);
    vi.spyOn(MockExecutor.prototype, 'start').mockImplementation(async task => {
      const stamp = JSON.parse(row(task.id).metadata).execution_recovery_attempt;
      expect(stamp).toMatchObject({ executorKind: 'mock', inProcess: true, sandboxed: false });
      expect(row(task.id).status).toBe('running');
      return { id: 'fixture-session', taskId: task.id, executorKind: 'mock', status: 'running', startedAt: new Date(),
        events: (async function* () {})(), result: new Promise(() => {}), cancel: async () => {} };
    });
    await engine.executeTask('mock-task', 'mock', 'owner');
    // Recovery never interferes with a session still owned by this engine.
    expect(engine.recoverInterruptedTasks()).toEqual({ failedMockTasks: 0, heldTasks: 0 });
    const restarted = new ExecutionEngine(db, ws as any);
    expect(restarted.recoverInterruptedTasks()).toEqual({ failedMockTasks: 1, heldTasks: 0 });
    expect(row('mock-task').status).toBe('failed');
    expect(JSON.parse(row('mock-task').metadata)).toMatchObject({ execution_recovery_hold: false, execution_recovery_outcome: 'interrupted_in_process' });
  });

  it.each([
    { executorKind: 'codex', inProcess: false, sandboxed: false },
    { executorKind: 'docker', inProcess: false, sandboxed: true },
    { executorKind: 'mock', inProcess: true, sandboxed: true },
  ])('holds real, fallback or sandbox attempts even when requested executor metadata says mock: %j', async actual => {
    insert('external', 'running', { executor: 'mock', execution_recovery_attempt: { ...actual, event_id: 'admitted', attempt_id: 'attempt' } });
    db.prepare(`INSERT INTO execution_events (id,task_id,event_type,message,level,metadata) VALUES ('admitted','external','log','fixture','info',?)`)
      .run(JSON.stringify({ ...actual, source: 'execution-engine', phase: 'admitted', attempt_id: 'attempt' }));
    expect(engine.recoverInterruptedTasks()).toEqual({ failedMockTasks: 0, heldTasks: 1 });
    await expect(engine.executeTask('external', 'mock', 'owner')).rejects.toThrow('EXECUTION_RECOVERY_REQUIRED');
  });

  it('prevents metadata/status/delete/dispatch bypass and strips reserved provenance on creation', async () => {
    insert('held'); engine.recoverInterruptedTasks();
    for (const body of [{ status: 'pending' }, { completed_at: new Date().toISOString() }]) {
      expect((await request(app).patch('/tasks/held').send(body)).status).toBe(409);
    }
    const changed = await request(app).patch('/tasks/held').send({ metadata: { execution_recovery_hold: false, execution_recovery_attempt: { executorKind: 'mock' }, note: 'allowed annotation' } });
    expect(changed.status).toBe(200);
    expect(changed.body.metadata.execution_recovery_hold).toBe(true);
    expect(changed.body.metadata.execution_recovery_attempt).toBeUndefined();
    expect((await request(app).delete('/tasks/held')).body.error.code).toBe('EXECUTION_RECOVERY_REQUIRED');
    expect((await request(app).post('/tasks/held/execute').send({ executor: 'mock' })).body.error.code).toBe('EXECUTION_RECOVERY_REQUIRED');
    const created = await request(app).post('/tasks').send({ title: 'New', description: 'Fixture', use_swarm_context: false,
      metadata: { execution_recovery_attempt: { executorKind: 'mock' }, execution_recovery_hold: false, note: 'kept' } });
    expect(created.status).toBe(201);
    expect(created.body.metadata.execution_recovery_attempt).toBeUndefined();
    expect(created.body.metadata.execution_recovery_hold).toBeUndefined();
    expect(created.body.metadata.note).toBe('kept');
    const hostile = await request(app).post('/tasks').send({ title: 'Host loader injection', description: 'Fixture', use_swarm_context: false,
      metadata: { environment: { NODE_OPTIONS: '--import=/tmp/untrusted.mjs', PATH: '/tmp/untrusted' } } });
    expect(hostile.status).toBe(400);
    expect(hostile.body.error.code).toBe('EXECUTOR_ENVIRONMENT_RESERVED');
    const envPatch = await request(app).patch(`/tasks/${created.body.id}`).send({ metadata: { environment: { NODE_OPTIONS: '--import=/tmp/untrusted.mjs' } } });
    expect(envPatch.status).toBe(200);
    expect(envPatch.body.metadata.environment).toBeUndefined();
    db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify({ environment: { DJIMITFLO_CONTROL_URL: 'http://localhost:3187' } }), created.body.id);
    const preserve = await request(app).patch(`/tasks/${created.body.id}`).send({ metadata: { environment: { PATH: '/tmp/untrusted' }, note: 'allowed' } });
    expect(preserve.status).toBe(200);
    expect(preserve.body.metadata.environment).toEqual({ DJIMITFLO_CONTROL_URL: 'http://localhost:3187' });
    insert('durable-running');
    expect((await request(app).patch('/tasks/durable-running').send({ status: 'pending' })).body.error.code).toBe('TASK_RUNNING');
    await expect(engine.executeTask('durable-running', 'mock', 'owner')).rejects.toThrow('TASK_RUNNING');
  });

  it('does not use a stale mock stamp when a newer real/fallback attempt was admitted', () => {
    insert('fallback', 'running', { execution_recovery_attempt: { event_id: 'mock-event', attempt_id: 'mock-attempt', executorKind: 'mock', inProcess: true, sandboxed: false } });
    const event = db.prepare(`INSERT INTO execution_events (id,task_id,event_type,message,level,metadata) VALUES (?,'fallback','log','fixture','info',?)`);
    event.run('mock-event', JSON.stringify({ source: 'execution-engine', phase: 'admitted', attempt_id: 'mock-attempt', executorKind: 'mock', inProcess: true, sandboxed: false }));
    event.run('real-event', JSON.stringify({ source: 'execution-engine', phase: 'admitted', attempt_id: 'real-attempt', executorKind: 'codex', inProcess: false, sandboxed: false }));
    expect(engine.recoverInterruptedTasks()).toEqual({ failedMockTasks: 0, heldTasks: 1 });
  });

  it('blocks loop replay of a held predecessor without creating a second task, while reusing completed results', async () => {
    insert('previous', 'paused', { execution_recovery_hold: true });
    const dispatch = vi.fn().mockResolvedValue({ status: 'denied' });
    const loops = { buildNestedSpawnEnv: vi.fn(() => ({})), isHighRiskRun: vi.fn(() => false), patchWorkerLeaseMetadata: vi.fn(), updateWorkerLeaseStatus: vi.fn() };
    const workers = new LoopWorkerExecutorService(db, loops as any, { executeTask: dispatch } as any);
    const invoke = () => (workers as any).executeViaEngine({ id: 'loop', loop_name: 'fixture' }, { id: 'lease', role: 'maker', metadata: { execution_task_id: 'previous' } }, 'codex', 'fixture', '/tmp', 1000, false);
    await expect(invoke()).rejects.toThrow('LOOP_WORKER_EXECUTION_RECOVERY_REQUIRED');
    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 1 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(loops.patchWorkerLeaseMetadata).not.toHaveBeenCalled();
    db.prepare("UPDATE tasks SET status = 'completed', metadata = ? WHERE id = 'previous'")
      .run(JSON.stringify({ executionResult: { status: 'completed', stdout: 'existing evidence', stderr: '', message: 'done' } }));
    await expect(invoke()).resolves.toMatchObject({ exitCode: 0, stdout: 'existing evidence' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 1 });
  });
});
