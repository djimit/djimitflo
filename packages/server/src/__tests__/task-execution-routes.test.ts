import express from 'express';
import Database from 'better-sqlite3';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecutionEventType, LogLevel, UserRole, type Task } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ExecutionEngine } from '../execution/execution-engine';
import type { ExecutionSession, TaskExecutor } from '../execution/types';
import { createAuthMiddleware } from '../middleware/auth';
import { errorHandler } from '../middleware/error-handler';
import { createTaskRoutes } from '../routes/tasks';
import { AuthService } from '../services/auth-service';

class FastMockExecutor implements TaskExecutor {
  readonly kind = 'mock' as const;

  canExecute(): boolean {
    return true;
  }

  async start(task: Task): Promise<ExecutionSession> {
    async function* events() {
      yield {
        task_id: task.id,
        event_type: ExecutionEventType.TASK_STARTED,
        message: 'Fast execution started',
        level: LogLevel.INFO,
      };
      yield {
        task_id: task.id,
        event_type: ExecutionEventType.TASK_COMPLETED,
        message: 'Fast execution completed',
        level: LogLevel.INFO,
      };
    }

    return {
      id: 'fast-session',
      taskId: task.id,
      executorKind: 'mock',
      status: 'running',
      startedAt: new Date(),
      events: events(),
      result: Promise.resolve({
        status: 'completed',
        message: 'Fast execution completed',
        metrics: { executionTimeMs: 1, toolCalls: 0 },
      }),
      cancel: async () => {},
    };
  }
}

describe('task execution HTTP contract', () => {
  let db: Database.Database;
  let server: Server;
  let baseUrl: string;
  let token: string;

  beforeEach(async () => {
    process.env.JWT_SECRET = 'task-route-test-secret';
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);

    const authService = new AuthService(db);
    const admin = authService.createUser('task-route@example.invalid', 'test-password', UserRole.ADMIN);
    token = authService.generateToken(admin);
    const auth = createAuthMiddleware(authService);
    const engine = new ExecutionEngine(db, {
      broadcastTaskEvent: () => {},
      broadcastTaskEventById: () => {},
      broadcast: () => {},
      close: () => {},
    } as any);
    engine.registerExecutor(new FastMockExecutor());

    const app = express();
    app.use(express.json());
    app.use('/tasks', auth.requireAuth, createTaskRoutes(db, engine, auth));
    app.use(errorHandler);
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    delete process.env.JWT_SECRET;
  });

  async function request(path: string, method = 'GET', body?: unknown, authenticated = true) {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it('authenticates, executes a task, and persists risk and execution evidence', async () => {
    const create = await request('/tasks', 'POST', {
      title: 'HTTP execution proof',
      description: 'Complete through the real route boundary',
      execution_mode: 'local',
      risk_level: 'low',
      use_swarm_context: false,
    });
    expect(create.status).toBe(201);
    const task = await create.json() as any;

    const execute = await request(`/tasks/${task.id}/execute`, 'POST', { executor: 'mock' });
    expect(execute.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const stored = await (await request(`/tasks/${task.id}`)).json() as any;
    const events = await (await request(`/tasks/${task.id}/events`)).json() as any;
    const risk = db.prepare('SELECT COUNT(*) AS count FROM risk_assessments WHERE task_id = ?').get(task.id) as { count: number };

    expect(stored.status).toBe('completed');
    expect(events.events.map((event: any) => event.event_type)).toEqual(
      expect.arrayContaining([ExecutionEventType.TASK_STARTED, ExecutionEventType.TASK_COMPLETED]),
    );
    expect(risk.count).toBe(1);
  });

  it('requires authentication', async () => {
    const response = await request('/tasks', 'POST', {
      title: 'Unauthenticated',
      description: 'Must not be created',
    }, false);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
  });

  it.each([
    ['status', 'invented'],
    ['priority', 'urgent'],
    ['risk_level', 'extreme'],
    ['execution_mode', 'auto'],
  ])('rejects invalid %s before SQLite', async (field, value) => {
    const response = await request('/tasks', 'POST', {
      title: 'Invalid task input',
      description: 'Must fail at the HTTP boundary',
      use_swarm_context: false,
      [field]: value,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  });

  it('rejects an unknown executor as client input', async () => {
    const create = await request('/tasks', 'POST', {
      title: 'Unknown executor',
      description: 'Must not reach engine failure',
      execution_mode: 'local',
      use_swarm_context: false,
    });
    const task = await create.json() as any;

    const response = await request(`/tasks/${task.id}/execute`, 'POST', { executor: 'does-not-exist' });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_EXECUTOR' } });
  });

  it('rejects cancellation when a task is not running', async () => {
    const create = await request('/tasks', 'POST', {
      title: 'Not running',
      description: 'Cancellation has a conflict contract',
      execution_mode: 'local',
      use_swarm_context: false,
    });
    const task = await create.json() as any;

    const response = await request(`/tasks/${task.id}/cancel`, 'POST', {});

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'TASK_NOT_RUNNING' } });
  });
});
