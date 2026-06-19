import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createMessageRoutes } from '../routes/messages';
import { errorHandler } from '../middleware/error-handler';
import { messageBus } from '../services/message_bus';
import { WebSocketEventType } from '@djimitflo/shared';

let db: Database.Database;
let server: Server;
let baseUrl: string;
let broadcasts: any[];

function insertAgent(id: string, name: string) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO agents (
      id, name, description, status, capabilities, total_tasks,
      completed_tasks, failed_tasks, total_execution_time_ms,
      total_token_usage, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?, ?, ?)
  `).run(id, name, `${name} agent`, 'idle', '[]', '{}', now, now);
}

async function startApp() {
  const app = express();
  const auth = {
    requirePermission: () => (_req: any, _res: any, next: any) => next(),
  } as any;
  const wsService = {
    broadcastToAuthenticated: (message: any) => broadcasts.push(message),
  } as any;

  app.use(express.json());
  app.use('/messages', createMessageRoutes(db, wsService, auth));
  app.use(errorHandler);

  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

describe('message routes', () => {
  beforeEach(async () => {
    broadcasts = [];
    messageBus.disconnect();
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    insertAgent('agent-a', 'Agent A');
    insertAgent('agent-b', 'Agent B');
    await startApp();
  });

  afterEach(async () => {
    messageBus.disconnect();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
    db.close();
  });

  it('creates, publishes, lists, reads, and marks messages read', async () => {
    const received: any[] = [];
    messageBus.subscribe('agent-b', (message) => received.push(message));

    const createResponse = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from_agent_id: 'agent-a',
        to_agent_id: 'agent-b',
        type: 'task_delegation',
        priority: 'high',
        payload: { task_id: 'task-123' },
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as any;
    expect(created).toMatchObject({
      from_agent_id: 'agent-a',
      to_agent_id: 'agent-b',
      type: 'task_delegation',
      priority: 'high',
      payload: { task_id: 'task-123' },
      read_at: null,
    });
    expect(received).toHaveLength(1);
    expect(received[0].id).toBe(created.id);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].type).toBe(WebSocketEventType.MESSAGE_SENT);

    const listResponse = await fetch(`${baseUrl}/messages/agent/agent-b?unread_only=true`);
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json() as any;
    expect(list.count).toBe(1);
    expect(list.messages[0].id).toBe(created.id);

    const readResponse = await fetch(`${baseUrl}/messages/${created.id}/read`, { method: 'PATCH' });
    expect(readResponse.status).toBe(200);
    const read = await readResponse.json() as any;
    expect(read.id).toBe(created.id);
    expect(read.read_at).toEqual(expect.any(String));

    const getResponse = await fetch(`${baseUrl}/messages/${created.id}`);
    expect(getResponse.status).toBe(200);
    const fetched = await getResponse.json() as any;
    expect(fetched.read_at).toBe(read.read_at);
  });

  it('rejects messages for unknown agents', async () => {
    const response = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from_agent_id: 'agent-a',
        to_agent_id: 'missing-agent',
        type: 'alert',
      }),
    });

    expect(response.status).toBe(400);
    const body = await response.json() as any;
    expect(body.error.code).toBe('INVALID_INPUT');
  });
});
