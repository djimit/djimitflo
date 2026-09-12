import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createTestDb } from './helpers/test-db';

import { createMessageRoutes } from '../routes/messages';
import { errorHandler } from '../middleware/error-handler';
import { messageBus } from '../services/message_bus';
import { AgentCommunicationService } from '../services/agent-communication-service';
import { WebSocketEventType } from '@djimitflo/shared';

let db: Database.Database;
let server: Server;
let baseUrl: string;
let broadcasts: any[];

function insertAgent(id: string, name: string) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO agents (
      id, name, description, status, capabilities_json, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
    db = createTestDb();
    db.pragma('foreign_keys = ON');
    
    
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

    const readResponse = await fetch(`${baseUrl}/messages/${created.id}/read`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_id: 'agent-b' }),
    });
    expect(readResponse.status).toBe(200);
    const read = await readResponse.json() as any;
    expect(read.id).toBe(created.id);
    expect(read.read_at).toEqual(expect.any(String));

    const getResponse = await fetch(`${baseUrl}/messages/${created.id}`);
    expect(getResponse.status).toBe(200);
    const fetched = await getResponse.json() as any;
    expect(fetched.read_at).toBe(read.read_at);
  });

  it('rejects malformed message list limits before querying SQLite', async () => {
    for (const value of ['0', '-1', '1.5', 'NaN']) {
      const response = await fetch(`${baseUrl}/messages/agent/agent-b?limit=${value}`);
      expect(response.status, value).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
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

  it('rejects evidence-free claims on the legacy message route', async () => {
    const response = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from_agent_id: 'agent-a',
        to_agent_id: 'agent-b',
        type: 'knowledge_share',
        payload: { epistemic_role: 'claim', statement: 'unsupported' },
      }),
    });

    expect(response.status).toBe(400);
    const body = await response.json() as any;
    expect(body.error.code).toBe('BOARD_CLAIM_EVIDENCE_REQUIRED');
  });

  it('rejects camelCase evidence-free claims on the legacy message route', async () => {
    const response = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from_agent_id: 'agent-a', to_agent_id: 'agent-b', type: 'knowledge_share',
        payload: { epistemicRole: 'claim', statement: 'unsupported' },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'BOARD_CLAIM_EVIDENCE_REQUIRED' } });
  });

  it('replays an idempotent legacy message without republishing it', async () => {
    const body = {
      from_agent_id: 'agent-a', to_agent_id: 'agent-b', type: 'status_update',
      idempotency_key: 'legacy-1', payload: { state: 'ready' },
    };
    const firstResponse = await fetch(`${baseUrl}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const first = await firstResponse.json() as any;
    const secondResponse = await fetch(`${baseUrl}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const second = await secondResponse.json() as any;
    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(200);
    expect(second.id).toBe(first.id);
    expect(broadcasts).toHaveLength(1);
  });

  it('rejects a cross-store idempotency collision instead of duplicating a board event', async () => {
    const service = new AgentCommunicationService(db);
    const durable = service.send({ from: 'agent-a', to: 'agent-b', type: 'alert', action: 'shared-alert', idempotencyKey: 'shared-board-key' });
    expect(db.prepare('SELECT store, message_id FROM board_idempotency_keys WHERE idempotency_key = ?').get('shared-board-key'))
      .toEqual({ store: 'agent_messages', message_id: durable.id });
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 });

    const response = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from_agent_id: 'agent-a', to_agent_id: 'agent-b', type: 'alert',
        idempotency_key: 'shared-board-key', payload: { action: 'duplicate-alert' },
      }),
    });

    const responseBody = await response.json();
    expect(response.status, JSON.stringify({ responseBody, reservations: db.prepare('SELECT * FROM board_idempotency_keys').all() })).toBe(409);
    expect(responseBody).toMatchObject({ error: { code: 'BOARD_IDEMPOTENCY_SCOPE_CONFLICT' } });
    expect(db.prepare('SELECT COUNT(*) AS count FROM agent_messages WHERE id = ?').get(durable.id)).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE type = 'alert'").get()).toMatchObject({ count: 0 });
  });

  it('deletes only messages owned by the sender principal', async () => {
    const created = await (await fetch(`${baseUrl}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from_agent_id: 'agent-a', to_agent_id: 'agent-b', type: 'alert' }),
    })).json() as any;
    const response = await fetch(`${baseUrl}/messages/${created.id}`, { method: 'DELETE' });
    expect(response.status).toBe(204);
  });

  it('does not replay a historical legacy row when the durable store owns its key', async () => {
    const service = new AgentCommunicationService(db);
    const durable = service.send({ from: 'agent-a', to: 'agent-b', type: 'alert', action: 'shared-alert', idempotencyKey: 'historical-overlap' });
    // A pre-reservation database can contain overlapping rows in both stores.
    // Backfill preserves the first owner; the losing row must not bypass it.
    db.prepare(`INSERT INTO messages
      (id, from_agent_id, to_agent_id, type, payload, priority, created_at, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('historical-legacy', 'agent-a', 'agent-b', 'alert', '{"action":"shared-alert"}', 'low', '2020-01-01T00:00:00.000Z', 'historical-overlap');
    new AgentCommunicationService(db);

    const response = await fetch(`${baseUrl}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from_agent_id: 'agent-a', to_agent_id: 'agent-b', type: 'alert',
        idempotency_key: 'historical-overlap', payload: { action: 'shared-alert' } }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'BOARD_IDEMPOTENCY_SCOPE_CONFLICT' } });
    expect(db.prepare('SELECT store, message_id FROM board_idempotency_keys').get())
      .toEqual({ store: 'agent_messages', message_id: durable.id });
    expect(broadcasts).toHaveLength(0);
  });

  it('does not replay a historical durable row when the legacy store owns its key', async () => {
    const response = await fetch(`${baseUrl}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from_agent_id: 'agent-a', to_agent_id: 'agent-b', type: 'alert',
        idempotency_key: 'historical-overlap', payload: { action: 'shared-alert' } }),
    });
    expect(response.status).toBe(201);
    const legacy = await response.json() as { id: string };
    new AgentCommunicationService(db); // Apply the durable store's additive columns.
    db.prepare(`INSERT INTO agent_messages
      (id, from_agent, to_agent, type, priority, payload_json, timestamp, ttl, status, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('historical-durable', 'agent-a', 'agent-b', 'alert', 3,
        '{"action":"shared-alert","params":{}}', '2020-01-01T00:00:00.000Z', 300, 'pending', 'historical-overlap');
    const service = new AgentCommunicationService(db);
    expect(() => service.send({ from: 'agent-a', to: 'agent-b', type: 'alert',
      action: 'shared-alert', idempotencyKey: 'historical-overlap' }))
      .toThrow('BOARD_IDEMPOTENCY_SCOPE_CONFLICT');
    expect(db.prepare('SELECT store, message_id FROM board_idempotency_keys').get())
      .toEqual({ store: 'messages', message_id: legacy.id });
    expect(broadcasts).toHaveLength(1);
  });
});
