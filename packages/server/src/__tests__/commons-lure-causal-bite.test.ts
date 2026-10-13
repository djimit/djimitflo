import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type Database from 'better-sqlite3';
import { createAgentSocialRuntimeRoutes } from '../routes/swarm-orchestration';
import { AgentCommunicationService } from '../services/agent-communication-service';
import { AgentLureService } from '../services/agent-lure-service';
import { AgentSocialAutopilotService, RESIDENTS } from '../services/agent-social-autopilot-service';
import { mintSpawnToken } from '../services/spawn-token';
import { createTestDb } from './helpers/test-db';

/**
 * Phase CR baseline defects 2/3/4/6: a lure invite must be deliverable over the token path, a bite must be a stored,
 * causal event (heartbeat AFTER delivery, inside the window), and heartbeat provenance must say how the agent got in.
 */
describe('agent commons lure: deliverable invites, causal bite events, honest provenance', () => {
  let db: Database.Database; let server: Server; let base: string; let comms: AgentCommunicationService; let lure: AgentLureService;
  const secret = 'test-lure-causal-secret-with-enough-entropy';
  const lapsed = '{"social_runtime":{"last_heartbeat_at":"2026-09-01T00:00:00.000Z"}}';
  const json = { 'Content-Type': 'application/json' };
  const beat = (agent: string, token: string) => fetch(`${base}/${agent}/heartbeat`, { method: 'POST', headers: { ...json, 'X-Agent-Social-Token': token }, body: JSON.stringify({ runtime: 'ollama', model_id: 'qwen' }) });
  const poll = async (agent: string, token: string) => (await (await fetch(`${base}/${agent}/messages`, { headers: { 'X-Agent-Social-Token': token } })).json()).messages as Array<{ id: string; status: string; payload: { action: string; thread_id: string } }>;
  const events = (agent: string) => (db.prepare('SELECT transition FROM lure_events WHERE agent_id = ? ORDER BY rowid').all(agent) as Array<{ transition: string }>).map((row) => row.transition);
  const provenance = (agent: string) => JSON.parse((db.prepare('SELECT metadata FROM agents WHERE id = ?').get(agent) as { metadata: string }).metadata).social_runtime.provenance_status;

  beforeEach(async () => {
    process.env.JWT_SECRET = secret;
    db = createTestDb();
    db.prepare('INSERT INTO agents (id, name, status, metadata) VALUES (?, ?, ?, ?), (?, ?, ?, ?)').run('silent', 'Silent', 'idle', lapsed, 'quiet', 'Quiet', 'idle', lapsed);
    comms = new AgentCommunicationService(db);
    lure = new AgentLureService(db, comms);
    const app = express(); app.use(express.json()); app.use('/social-runtime', createAgentSocialRuntimeRoutes(db));
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => { const address = server.address(); base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/social-runtime`; resolve(); }); });
  });

  afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); delete process.env.JWT_SECRET; });

  it('delivers a social.invite over the token path, marks it read, and records published -> delivered -> bitten', async () => {
    const cast = lure.castLure({ by: 'op', baseUrl: 'http://x', mintTokens: false });
    expect(cast.lure.invited).toEqual(['quiet', 'silent']);
    expect(events('silent')).toEqual(['invite_published']);
    const token = mintSpawnToken(secret, 'silent', 'social-runtime', 60_000);

    // A heartbeat BEFORE the invite was delivered is coincident, not a bite.
    expect((await beat('silent', token)).status).toBe(200);
    let invitee = lure.status().lures[0].invitees.find((i) => i.agent_id === 'silent')!;
    expect(invitee).toMatchObject({ state: 'invited', bit_at: null });
    expect(invitee.coincident_heartbeat).toEqual(expect.any(String));

    const messages = await poll('silent', token);
    expect(messages.map((m) => m.payload.action)).toEqual(['social.invite']);
    expect(messages[0].payload.thread_id).toBe(cast.lure.id);
    expect((db.prepare('SELECT status FROM agent_messages WHERE id = ?').get(messages[0].id) as { status: string }).status).toBe('read');
    expect(await poll('silent', token)).toEqual([]); // delivered once
    expect(events('silent')).toEqual(['invite_published', 'invite_delivered']);
    expect(lure.status().lures[0].invitees.find((i) => i.agent_id === 'silent')).toMatchObject({ state: 'seen' });

    expect((await beat('silent', token)).status).toBe(200);
    expect((await beat('silent', token)).status).toBe(200); // a second heartbeat is not a second bite
    expect(events('silent')).toEqual(['invite_published', 'invite_delivered', 'bitten']);
    const status = lure.status();
    invitee = status.lures[0].invitees.find((i) => i.agent_id === 'silent')!;
    expect(invitee).toMatchObject({ state: 'bit', bit_at: expect.any(String) });
    expect(status.lures[0].bites).toBe(1);

    // Totals come from the event log, not from the newest-20 window.
    const insert = db.prepare("INSERT INTO social_lures (id, topic, topic_ref, created_by, created_at, expires_at, invited_json) VALUES (?, 't', 'r', 'op', ?, ?, '[]')");
    for (let i = 0; i < 20; i += 1) insert.run(`lure:filler-${i}`, `2999-01-01T00:00:${String(i).padStart(2, '0')}.000Z`, '2999-01-02T00:00:00.000Z');
    const later = lure.status();
    expect(later.lures.some((l) => l.id === cast.lure.id)).toBe(false);
    expect(later.totals).toMatchObject({ lures: 21, invitations: 2, delivered: 1, bitten: 1 });
  });

  it('records expired-undelivered and expired-delivered-no-response once the window closes', async () => {
    const cast = lure.castLure({ by: 'op', baseUrl: 'http://x', mintTokens: false });
    expect(await poll('silent', mintSpawnToken(secret, 'silent', 'social-runtime', 60_000))).toHaveLength(1);
    db.prepare("UPDATE social_lures SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(cast.lure.id);
    const status = lure.status();
    lure.status(); // idempotent sweep
    expect(events('silent')).toEqual(['invite_published', 'invite_delivered', 'expired_delivered_no_response']);
    expect(events('quiet')).toEqual(['invite_published', 'expired_undelivered']);
    expect(status.lures[0].invitees.map((i) => i.state)).toEqual(['expired', 'expired']);
    expect(status.totals).toMatchObject({ expired_undelivered: 1, expired_delivered_no_response: 1, bitten: 0 });
  });

  it('logs why a token was refused, and still records the probe (honeypot)', async () => {
    const expired = mintSpawnToken(secret, 'silent', 'social-runtime', -1_000);
    const otherAgent = mintSpawnToken(secret, 'quiet', 'social-runtime', 60_000);
    expect((await beat('silent', expired)).status).toBe(401);
    expect((await beat('silent', otherAgent)).status).toBe(401);
    expect((await fetch(`${base}/silent/messages`)).status).toBe(401);
    const reasons = (db.prepare('SELECT reason FROM social_lure_probes ORDER BY rowid').all() as Array<{ reason: string }>).map((row) => row.reason);
    expect(reasons).toEqual(['token_invalid:expired', 'token_invalid:wrong_subject', 'token_missing']);
  });

  it('labels heartbeat provenance by how the agent got in: runtime_token vs in_process_resident', async () => {
    expect((await beat('silent', mintSpawnToken(secret, 'silent', 'social-runtime', 60_000))).status).toBe(200);
    expect(provenance('silent')).toBe('runtime_token');
    const autopilot = new AgentSocialAutopilotService(db, { runtime: 'ollama', model: 'test-model', ollamaUrl: 'http://ollama.invalid', agents: 'residents', intervalMs: 60_000, roundCooldownMs: 0, maxRepliesPerTick: 1, seedResidents: true },
      { comms, chat: async () => { throw new Error('no inference in this test'); } });
    autopilot.seedResidents();
    expect((await autopilot.tick()).heartbeats).toBe(RESIDENTS.length);
    expect(provenance(RESIDENTS[0].id)).toBe('in_process_resident');
    expect(JSON.stringify(db.prepare('SELECT metadata FROM agents').all())).not.toContain('signed_runtime_poller');
  });
});
