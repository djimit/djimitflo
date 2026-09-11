import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ExecutionEngine } from '../execution/execution-engine';
import { LoopService } from '../services/loop-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { OperatorInterventionService } from '../services/operator-intervention';
import { runtimeConcurrencySemaphore } from '../services/concurrency-semaphore';
import { createTaskRoutes } from '../routes/tasks';
import { errorHandler } from '../middleware/error-handler';
import type { Task } from '@djimitflo/shared';

let db: Database.Database;
let loops: LoopService;
let engine: ExecutionEngine;
let goalId: string;
let start: ReturnType<typeof vi.fn>;
beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  loops = new LoopService(db);
  goalId = loops.createGoal({ objective: 'Temporary pause fixture', acceptance_criteria: ['No provider'] }).id;
  db.prepare('INSERT INTO loop_runs(id,goal_id,loop_name,mode,status,metadata) VALUES(?,?,?,?,?,?)')
    .run('bound-run', goalId, 'doc-drift-and-small-fix-loop', 'closed', 'planning', '{}');
  db.prepare(`INSERT INTO tasks(id,title,description,status,priority,risk_level,execution_mode,metadata,created_by,owner_user_id)
    VALUES ('bound-task','Fixture','echo hello','completed','low','low','local',?,'owner','owner')`).run(JSON.stringify({ loop_run_id: 'bound-run', lease_id: 'bound-lease' }));
  db.prepare(`INSERT INTO worker_leases(id,loop_run_id,role,runtime,status,metadata)
    VALUES ('bound-lease','bound-run','maker','mock','completed',?)`).run(JSON.stringify({ execution_task_id: 'bound-task' }));
  start = vi.fn(async (task: Task) => ({
    id: 'fixture-session', taskId: task.id, executorKind: 'mock' as const, status: 'running' as const, startedAt: new Date(),
    events: (async function* () {})(), cancel: async () => {},
    result: Promise.resolve({ status: 'completed' as const, message: 'Local in-process fixture only', metrics: {} }),
  }));
  engine = new ExecutionEngine(db);
  engine.registerExecutor({ kind: 'mock', canExecute: () => true, start });
});
afterEach(() => {
  runtimeConcurrencySemaphore.release('pause-fixture-reservation');
  runtimeConcurrencySemaphore.release('execution:bound-task');
  runtimeConcurrencySemaphore.release('execution:unrelated-task');
  vi.restoreAllMocks(); vi.unstubAllEnvs(); db.close();
});

async function pause() {
  await new OperatorInterventionService(db, loops, new SwarmIntelligenceService(db)).pauseGoal(goalId, 'fixture-operator');
}

it('blocks completed-task redispatch after an actual quiescent goal pause', async () => {
  await pause();
  await expect(engine.executeTask('bound-task', 'mock')).rejects.toMatchObject({ code: 'LOOP_OPERATOR_PAUSED' });
  expect(start).not.toHaveBeenCalled();
  expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get('bound-task')).toEqual({ status: 'completed' });
  expect(runtimeConcurrencySemaphore.activeCount).toBe(0);
});

it.each(['run', 'goal'])('honors the current %s pause flag even when the other flag is absent', async (owner) => {
  if (owner === 'run') db.prepare('UPDATE loop_runs SET metadata=? WHERE id=?').run('{"operator_paused":true}', 'bound-run');
  else db.prepare('UPDATE goals SET metadata=? WHERE id=?').run('{"operator_paused":true}', goalId);
  await expect(engine.executeTask('bound-task', 'mock')).rejects.toMatchObject({ code: 'LOOP_OPERATOR_PAUSED' });
  expect(start).not.toHaveBeenCalled();
});

it('also resolves the owning loop through a lease-only task binding', async () => {
  await pause();
  db.prepare('UPDATE tasks SET metadata=? WHERE id=?').run('{"lease_id":"bound-lease"}', 'bound-task');
  await expect(engine.executeTask('bound-task', 'mock')).rejects.toMatchObject({ code: 'LOOP_OPERATOR_PAUSED' });
  expect(start).not.toHaveBeenCalled();
});

it('resolves the canonical worker binding even when historical task metadata was already erased', async () => {
  await pause();
  db.prepare('UPDATE tasks SET metadata=? WHERE id=?').run('{}', 'bound-task');
  await expect(engine.executeTask('bound-task', 'mock')).rejects.toMatchObject({ code: 'LOOP_OPERATOR_PAUSED' });
  expect(start).not.toHaveBeenCalled();
});

it('does not block unrelated tasks or goals blocked for a reason other than operator pause', async () => {
  loops.updateGoal(goalId, { status: 'blocked' });
  const bound = await engine.executeTask('bound-task', 'mock');
  await bound.completion;
  db.prepare('UPDATE goals SET metadata=? WHERE id=?').run('{"operator_paused":true}', goalId);
  db.prepare(`INSERT INTO tasks(id,title,description,status,priority,risk_level,execution_mode,metadata)
    VALUES ('unrelated-task','Fixture','echo hello','pending','low','low','local','{}')`).run();
  const unrelated = await engine.executeTask('unrelated-task', 'mock');
  await unrelated.completion;
  expect(start).toHaveBeenCalledTimes(2);
});

it('rechecks pause state after a real shared-semaphore capacity wait and releases the permit on refusal', async () => {
  vi.stubEnv('RUNTIME_MAX_CONCURRENCY', '1');
  await runtimeConcurrencySemaphore.acquire('pause-fixture-reservation');
  const dispatch = engine.executeTask('bound-task', 'mock');
  const rejection = expect(dispatch).rejects.toMatchObject({ code: 'LOOP_OPERATOR_PAUSED' });
  await Promise.resolve();
  expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get('bound-task')).toEqual({ status: 'queued' });
  // Simulate an independently persisted pause while admission is waiting. The
  // normal operator route itself rejects a busy queued task rather than drain it.
  db.prepare('UPDATE goals SET metadata=? WHERE id=?').run('{"operator_paused":true}', goalId);
  runtimeConcurrencySemaphore.release('pause-fixture-reservation');
  await rejection;
  expect(start).not.toHaveBeenCalled();
  expect(runtimeConcurrencySemaphore.activeCount).toBe(0);
});

it('does not escape a newly paused goal through fallback after a failed runtime start', async () => {
  const fallback = vi.fn(async () => { throw new Error('Unexpected fallback start'); });
  start.mockImplementationOnce(async () => {
    db.prepare('UPDATE goals SET metadata=? WHERE id=?').run('{"operator_paused":true}', goalId);
    throw new Error('Provider temporarily unavailable before process start');
  });
  for (const kind of ['codex', 'claude', 'gemini'] as const) engine.registerExecutor({ kind, canExecute: () => true, start: fallback });
  await expect(engine.executeTask('bound-task', 'mock')).rejects.toMatchObject({ code: 'LOOP_OPERATOR_PAUSED' });
  expect(start).toHaveBeenCalledOnce();
  expect(fallback).not.toHaveBeenCalled();
  expect(runtimeConcurrencySemaphore.activeCount).toBe(0);
});

it('preserves canonical server-created loop/lease bindings through metadata replacement, retaining editable ordinary metadata', async () => {
  await pause();
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.user = { sub: 'owner', role: 'admin' }; next(); });
  app.use('/tasks', createTaskRoutes(db, engine)); app.use(errorHandler);
  const patch = await request(app).patch('/tasks/bound-task').send({ metadata: { note: 'Editable', loop_run_id: 'other-run', lease_id: null } });
  expect(patch.status).toBe(200);
  expect(patch.body.metadata).toMatchObject({ note: 'Editable', loop_run_id: 'bound-run', lease_id: 'bound-lease' });
  await expect(engine.executeTask('bound-task', 'mock')).rejects.toMatchObject({ code: 'LOOP_OPERATOR_PAUSED' });
  const erase = await request(app).patch('/tasks/bound-task').send({ metadata: {} });
  expect(erase.body.metadata).toMatchObject({ loop_run_id: 'bound-run', lease_id: 'bound-lease' });
  expect(start).not.toHaveBeenCalled();
});
