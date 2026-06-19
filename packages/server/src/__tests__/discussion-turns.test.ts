import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createDiscussionRoutes } from '../routes/discussions';
import { errorHandler } from '../middleware/error-handler';
import { WebSocketEventType } from '@djimitflo/shared';
import { DiscussionTurnService } from '../services/discussion-turn-service';

let db: Database.Database;
let server: Server;
let baseUrl: string;
let broadcasts: any[];

async function startApp(auth?: any) {
  const app = express();
  const useAuth = auth ?? {
    requirePermission: () => (_req: any, _res: any, next: any) => next(),
  };
  const wsService = {
    broadcastToAuthenticated: (message: any) => broadcasts.push(message),
  } as any;

  app.use(express.json());
  app.use('/discussions', createDiscussionRoutes(db, useAuth, wsService));
  app.use(errorHandler);

  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function createDiscussion(participants: string[], extra: Record<string, unknown> = {}): Promise<string> {
  const res = await fetch(`${baseUrl}/discussions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: 'T', description: 'D', metadata: { participants, ...extra } }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  return body.id;
}

async function appendTurn(discussionId: string, agentId: string, content: string, parentTurnId?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/discussions/${discussionId}/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, content, parent_turn_id: parentTurnId ?? null }),
  });
  return { status: res.status, body: await res.json() };
}

describe('discussion turn protocol (L4 part 2)', () => {
  beforeEach(async () => {
    broadcasts = [];
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    await startApp();
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    db.close();
  });

  it('appends an ordered turn and broadcasts DISCUSSION_TURN_ADDED', async () => {
    const id = await createDiscussion(['agent-a', 'agent-b']);
    const { status, body } = await appendTurn(id, 'agent-a', 'first turn');
    expect(status).toBe(201);
    expect(body.turn_index).toBe(1);
    expect(body.status).toBe('open');
    expect(body.agent_id).toBe('agent-a');
    expect(broadcasts.some((b) => b.type === WebSocketEventType.DISCUSSION_TURN_ADDED)).toBe(true);
  });

  it('rejects a turn from a non-participant', async () => {
    const id = await createDiscussion(['agent-a', 'agent-b']);
    const { status, body } = await appendTurn(id, 'agent-c', 'intruder');
    expect(status).toBe(403);
    expect(body.error.code).toBe('AGENT_NOT_IN_DISCUSSION');
  });

  it('allows any agent when no participants are configured', async () => {
    const id = await createDiscussion([]);
    const { status } = await appendTurn(id, 'agent-z', 'open discussion');
    expect(status).toBe(201);
  });

  it('rejects a second open turn while one is pending', async () => {
    const id = await createDiscussion(['agent-a', 'agent-b']);
    await appendTurn(id, 'agent-a', 'first');
    const { status, body } = await appendTurn(id, 'agent-b', 'second');
    expect(status).toBe(409);
    expect(body.error.code).toBe('OPEN_TURN_PENDING');
  });

  it('tick reports awaiting_commit while a turn is open, then round-robins after commit', async () => {
    const id = await createDiscussion(['agent-a', 'agent-b']);

    await appendTurn(id, 'agent-a', 'first');
    let tick = await (await fetch(`${baseUrl}/discussions/${id}/tick`, { method: 'POST' })).json();
    expect(tick.awaiting_commit).toBe(true);
    expect(tick.next_agent_id).toBe('agent-a');

    // commit the open turn
    const turns = await (await fetch(`${baseUrl}/discussions/${id}/turns`)).json();
    const commitRes = await fetch(`${baseUrl}/discussions/${id}/turns/${turns.turns[0].id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'committed' }),
    });
    expect(commitRes.status).toBe(200);
    expect(broadcasts.some((b) => b.type === WebSocketEventType.DISCUSSION_TURN_COMMITTED)).toBe(true);

    tick = await (await fetch(`${baseUrl}/discussions/${id}/tick`, { method: 'POST' })).json();
    expect(tick.awaiting_commit).toBe(false);
    expect(tick.next_agent_id).toBe('agent-b'); // committedCount=1 -> participants[1]
    expect(tick.turn_index).toBe(2);

    // second committed turn -> back to agent-a
    await appendTurn(id, 'agent-b', 'second');
    const turns2 = await (await fetch(`${baseUrl}/discussions/${id}/turns`)).json();
    await fetch(`${baseUrl}/discussions/${id}/turns/${turns2.turns[1].id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'committed' }),
    });
    tick = await (await fetch(`${baseUrl}/discussions/${id}/tick`, { method: 'POST' })).json();
    expect(tick.next_agent_id).toBe('agent-a'); // committedCount=2 -> participants[0]
  });

  it('supersedes a committed turn and rejects invalid transitions', async () => {
    const id = await createDiscussion(['agent-a']);
    await appendTurn(id, 'agent-a', 'first');
    const turns = await (await fetch(`${baseUrl}/discussions/${id}/turns`)).json();
    const turnId = turns.turns[0].id;

    // open -> superseded is allowed
    const sup = await fetch(`${baseUrl}/discussions/${id}/turns/${turnId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'superseded' }),
    });
    expect(sup.status).toBe(200);
    expect((await sup.json()).status).toBe('superseded');

    // superseded -> committed is invalid
    const bad = await fetch(`${baseUrl}/discussions/${id}/turns/${turnId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'committed' }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe('INVALID_TURN_STATUS');
  });

  it('allows a reply to a committed turn but not to an open/missing one', async () => {
    const id = await createDiscussion(['agent-a', 'agent-b']);
    await appendTurn(id, 'agent-a', 'first');
    const turns = await (await fetch(`${baseUrl}/discussions/${id}/turns`)).json();
    const firstId = turns.turns[0].id;

    // reply while first is still open -> blocked (open turn pending)
    const openReply = await appendTurn(id, 'agent-b', 'reply', firstId);
    expect(openReply.status).toBe(409);

    // commit first (no open turn now)
    await fetch(`${baseUrl}/discussions/${id}/turns/${firstId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'committed' }),
    });

    // reply to a nonexistent parent -> INVALID_PARENT_TURN (no open turn, so the
    // parent check is what fires)
    const badParent = await appendTurn(id, 'agent-a', 'bad', 'no-such-turn');
    expect(badParent.status).toBe(400);
    expect(badParent.body.error.code).toBe('INVALID_PARENT_TURN');

    // reply to the committed first turn -> allowed
    const reply = await appendTurn(id, 'agent-b', 'reply', firstId);
    expect(reply.status).toBe(201);
    expect(reply.body.parent_turn_id).toBe(firstId);
  });

  it('gates tick behind write:swarm_action and turn writes behind create:task', async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    // Viewer role: has read:* but not create:task / write:swarm_action
    const viewerAuth = {
      requirePermission: (perm: string) => (_req: any, res: any, next: any) => {
        const allowed = ['read:evidence', 'read:repository'];
        if (allowed.includes(perm)) return next();
        return res.status(403).json({ error: { message: 'forbidden', code: 'FORBIDDEN' } });
      },
    } as any;
    await startApp(viewerAuth);

    // Viewer cannot POST /discussions (create:task), so seed the discussion directly.
    db.prepare(`INSERT INTO discussions (id, topic, description, status, metadata, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?, ?)`)
      .run('d1', 'T', 'D', JSON.stringify({ participants: ['agent-a'] }), new Date().toISOString(), new Date().toISOString());

    const append = await fetch(`${baseUrl}/discussions/d1/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'agent-a', content: 'x' }),
    });
    expect(append.status).toBe(403); // create:task

    const tick = await fetch(`${baseUrl}/discussions/d1/tick`, { method: 'POST' });
    expect(tick.status).toBe(403); // write:swarm_action
  });
});

describe('DiscussionTurnService.computeNextTurn (unit)', () => {
  let sdb: Database.Database;

  beforeEach(() => {
    sdb = new Database(':memory:');
    sdb.pragma('foreign_keys = ON');
    sdb.exec(schema);
    runMigrations(sdb);
  });

  afterEach(() => sdb.close());

  it('round-robins and skips when an open turn is pending', () => {
    sdb.prepare(`INSERT INTO discussions (id, topic, description, status, metadata, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?, ?)`)
      .run('d', 'T', 'D', JSON.stringify({ participants: ['a', 'b', 'c'] }), new Date().toISOString(), new Date().toISOString());

    const svc = new DiscussionTurnService(sdb);
    expect(svc.computeNextTurn('d')).toMatchObject({ next_agent_id: 'a', awaiting_commit: false, reason: 'round-robin' });

    const t1 = svc.appendTurn('d', { agent_id: 'a', content: '1' });
    expect(svc.computeNextTurn('d')).toMatchObject({ next_agent_id: 'a', awaiting_commit: true });

    svc.setTurnStatus('d', t1.id, 'committed');
    expect(svc.computeNextTurn('d')).toMatchObject({ next_agent_id: 'b', awaiting_commit: false });

    const t2 = svc.appendTurn('d', { agent_id: 'b', content: '2' });
    svc.setTurnStatus('d', t2.id, 'committed');
    expect(svc.computeNextTurn('d')).toMatchObject({ next_agent_id: 'c' });

    const t3 = svc.appendTurn('d', { agent_id: 'c', content: '3' });
    svc.setTurnStatus('d', t3.id, 'committed');
    expect(svc.computeNextTurn('d')).toMatchObject({ next_agent_id: 'a' }); // wrapped
  });
});