import { it, expect } from 'vitest';
import express from 'express';
import { createServer } from 'http';
import { once } from 'events';
import Database from 'better-sqlite3';
import { WebSocket, WebSocketServer } from 'ws';
import { UserRole, ExecutionEventType, LogLevel } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AuthService } from '../services/auth-service';
import { WebSocketService } from '../services/websocket-service';
import { createAuthMiddleware } from '../middleware/auth';
import { createTaskRoutes } from '../routes/tasks';
import { errorHandler } from '../middleware/error-handler';
import { ExecutionEngine } from '../execution/execution-engine';

it('publishes persisted task CRUD through authenticated owner-scoped WebSockets', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  const authService = new AuthService(db);
  const owner = authService.createUser('task-owner@test', 'test-password-only', UserRole.ADMIN);
  const stranger = authService.createUser('task-stranger@test', 'test-password-only', UserRole.MAKER);
  const token = authService.generateToken(owner);
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const wsService = new WebSocketService(wss, authService, db);
  const auth = createAuthMiddleware(authService);
  app.use(express.json());
  app.use('/tasks', auth.requireAuth, createTaskRoutes(db, undefined, auth, wsService));
  app.use('/api/tasks', auth.requireAuth, createTaskRoutes(db, undefined, auth, wsService));
  app.use(errorHandler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('net').AddressInfo).port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, `bearer.${token}`);
  const outsider = new WebSocket(`ws://127.0.0.1:${port}/ws`, `bearer.${authService.generateToken(stranger)}`);
  const received: any[] = [], outsiderEvents: any[] = [];
  socket.on('message', data => received.push(JSON.parse(String(data))));
  outsider.on('message', data => outsiderEvents.push(JSON.parse(String(data))));
  await Promise.all([once(socket, 'open'), once(outsider, 'open')]);
  const call = (path: string, method: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    for (const query of ['limit=0', 'limit=-1', 'limit=1.5', 'limit=NaN', 'offset=-1', 'offset=1.5']) {
      const response = await call(`/tasks?${query}`, 'GET');
      expect(response.status, query).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
    const created = await call('/tasks', 'POST', { title: 'Live events', description: 'Read-only fixture', use_swarm_context: false });
    expect(created.status).toBe(201);
    const task = await created.json() as any;
    db.prepare(`INSERT INTO tasks (id,title,description,status,priority,risk_level,execution_mode,owner_user_id)
      VALUES ('event-route-proof','Events route proof','Fixture','pending','medium','low','review_only',?)`).run(owner.id);
    const canonicalEvents = await call('/api/tasks/event-route-proof/events', 'GET');
    expect(canonicalEvents.status).toBe(200);
    expect((await canonicalEvents.json() as any).events).toEqual([]);
    expect((await call(`/tasks/${task.id}`, 'PATCH', { title: 'Updated live events' })).status).toBe(200);
    expect((await call(`/tasks/${task.id}`, 'GET')).status).toBe(200);
    expect(db.prepare("SELECT count(*) AS n FROM audit_events WHERE task_id = ? AND event_type = 'task.created'").get(task.id)).toEqual({ n: 1 });
    const retained = await call(`/tasks/${task.id}`, 'DELETE');
    expect(retained.status).toBe(409);
    expect((await retained.json() as any).error.code).toBe('TASK_HAS_AUDIT_TRAIL');
    expect((await call(`/tasks/${task.id}`, 'GET')).status).toBe(200);
    db.prepare(`INSERT INTO tasks (id,title,description,status,priority,risk_level,execution_mode,owner_user_id)
      VALUES ('legacy-draft','Unaudited draft','Fixture','pending','medium','low','review_only',?)`).run(owner.id);
    expect((await call('/tasks/legacy-draft', 'DELETE')).status).toBe(204);
    expect((await call('/tasks/legacy-draft', 'GET')).status).toBe(404);
    // A ping/pong ensures earlier server messages have traversed the socket.
    const pong = once(socket, 'pong'); socket.ping(); await pong;
    expect(received.filter(e => e.type.startsWith('task.')).map(e => [e.type, e.payload.task.id])).toEqual([
      ['task.created', task.id], ['task.updated', task.id], ['task.deleted', 'legacy-draft'],
    ]);
    expect(received.find(e => e.type === 'task.updated').payload.task.title).toBe('Updated live events');
    expect(outsiderEvents.filter(e => e.type.startsWith('task.'))).toEqual([]);

    // Executor inputs have no timestamp. The live wire must carry the same
    // durable event time as REST, not just created_at or an invented UI time.
    const engine = new ExecutionEngine(db, wsService);
    const input = { task_id: task.id, event_type: ExecutionEventType.LOG,
      level: LogLevel.INFO, message: 'Canonical execution timestamp fixture' };
    const eventId = (engine as any).persistEvent(input) as string;
    (engine as any).broadcastExecutionEvent(task.id, eventId, input);
    const eventsResponse = await call(`/tasks/${task.id}/events`, 'GET');
    expect(eventsResponse.status).toBe(200);
    const eventsBody = await eventsResponse.json() as any;
    expect(eventsBody.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: eventId, task_id: task.id,
        message: input.message, metadata: {} }),
    ]));
    const eventPong = once(socket, 'pong'); socket.ping(); await eventPong;
    const live = received.find(e => e.type === 'execution.event' && e.payload.event.id === eventId)?.payload.event;
    const durable = db.prepare('SELECT timestamp, created_at, updated_at FROM execution_events WHERE id = ?').get(eventId);
    expect(live).toMatchObject(durable!);
    expect(Number.isFinite(Date.parse(live.timestamp))).toBe(true);
    expect(outsiderEvents.filter(e => e.type === 'execution.event')).toEqual([]);
  } finally {
    socket.terminate(); outsider.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
  }
});
