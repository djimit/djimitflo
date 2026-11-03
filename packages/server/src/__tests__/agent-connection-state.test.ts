import { expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { rateLimit } from 'express-rate-limit';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { connectionState, connectionStates, type ConnectionEvidence } from '../services/agent-connection-state';
import { createAgentRoutes } from '../routes/agents';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const h = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
const none: ConnectionEvidence = { last_seen_at: null, live: false, has_runtime: true, last_reply_at: null, token_issued_at: null, token_expires_at: null, unanswered_invites: 0 };

it('UX-14: an agent moves enrolled → token_issued → first_heartbeat → live → lapsed, each with its evidence', () => {
  expect(connectionState({ ...none }, NOW)).toEqual({ state: 'enrolled', reason: 'never enrolled: no token issued yet' });
  expect(connectionState({ ...none, token_issued_at: h(2), token_expires_at: h(-22) }, NOW)).toEqual({ state: 'token_issued', reason: 'token issued, never connected' });
  expect(connectionState({ ...none, token_issued_at: h(2), last_seen_at: h(1), live: true }, NOW)).toEqual({ state: 'first_heartbeat', reason: 'heartbeat in the last 24 h, no reply yet' });
  expect(connectionState({ ...none, last_seen_at: h(1), live: true, last_reply_at: h(3) }, NOW).state).toBe('live');
  expect(connectionState({ ...none, last_seen_at: h(30), last_reply_at: h(40) }, NOW)).toEqual({ state: 'lapsed', reason: 'no heartbeat in 24 h (last 30 h ago)' });
  expect(connectionState({ ...none, last_reply_at: h(5) }, NOW)).toEqual({ state: 'first_reply', reason: 'replied 5 h ago but never sent a heartbeat' });
  expect(connectionState({ ...none, retired_at: h(1), retirement_reason: 'unused', live: true }, NOW)).toEqual({ state: 'retired', reason: 'retired: unused' });
});

it('UX-14: never connected agents are explained — expired token, runtime missing, dormant after 3 unanswered invites', () => {
  expect(connectionState({ ...none, token_issued_at: h(50), token_expires_at: h(26) }, NOW)).toEqual({ state: 'token_issued', reason: 'token expired 26 h ago, never used' });
  expect(connectionState({ ...none, has_runtime: false }, NOW)).toEqual({ state: 'enrolled', reason: 'runtime missing: no social runtime configured' });
  expect(connectionState({ ...none, token_issued_at: h(2), unanswered_invites: 3 }, NOW)).toEqual({ state: 'dormant', reason: 'never connected; 3 invites unanswered' });
});

function seed() {
  const db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = ON');
  const agent = db.prepare("INSERT INTO agents (id, name, description, status, capabilities, metadata, last_active_at) VALUES (?, ?, 'd', 'active', '[]', ?, ?)");
  agent.run('talker', 'talker', JSON.stringify({ social_runtime: { enabled: true, last_heartbeat_at: h(1) } }), null);
  agent.run('ghost', 'ghost', JSON.stringify({ social_runtime: { enabled: true } }), null);
  agent.run('silent', 'silent', '{}', null);
  db.exec(`CREATE TABLE IF NOT EXISTS social_lures (id TEXT PRIMARY KEY, topic TEXT NOT NULL, topic_ref TEXT NOT NULL, created_by TEXT NOT NULL,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, invited_json TEXT NOT NULL DEFAULT '[]', paperclip_exported_at TEXT)`);
  const lure = db.prepare("INSERT INTO social_lures (id, topic, topic_ref, created_by, created_at, expires_at, invited_json) VALUES (?, 't', 'r', 'admin', ?, ?, ?)");
  for (let i = 0; i < 3; i++) lure.run(`l${i}`, h(100 - i), h(76 - i), JSON.stringify(['ghost']));
  db.exec(`CREATE TABLE IF NOT EXISTS agent_messages (id TEXT PRIMARY KEY, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL, type TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')))`); // created lazily by AgentCommunicationService in prod
  db.prepare("INSERT INTO agent_messages (id, from_agent, to_agent, type, timestamp) VALUES ('m1', 'talker', 'commons', 'chat', ?)").run(h(2));
  return db;
}

it('UX-14: states come from existing rows only (agents, social_lures, agent_messages); missing tables contribute nothing', () => {
  const db = seed();
  const agents = (db.prepare('SELECT * FROM agents').all() as Array<{ id: string; metadata: string }>).map((a) => ({ ...a, metadata: JSON.parse(a.metadata) }));
  const s = connectionStates(db, agents, NOW);
  expect(s.get('talker')?.state).toBe('live');
  expect(s.get('ghost')).toEqual({ state: 'dormant', reason: 'never connected; 3 invites unanswered' });
  expect(s.get('silent')).toEqual({ state: 'enrolled', reason: 'runtime missing: no social runtime configured' });
  expect(connectionStates(new Database(':memory:'), [{ id: 'x' }], NOW).get('x')).toEqual({ state: 'enrolled', reason: 'runtime missing: no social runtime configured' });
});

it('UX-14: GET /api/agents adds connection_state and connection_reason; existing fields are unchanged', async () => {
  const db = seed();
  const app = express().use(rateLimit({ windowMs: 60_000, limit: 600 })).use('/api/agents', createAgentRoutes(db));
  const res = await request(app).get('/api/agents').expect(200);
  const ghost = res.body.agents.find((a: { id: string }) => a.id === 'ghost');
  expect(ghost).toMatchObject({ id: 'ghost', name: 'ghost', status: 'active', capabilities: [], liveness: 'unknown', connection_state: 'dormant' });
  expect(ghost.connection_reason).toContain('3 invites unanswered');
  expect(Object.keys(ghost)).toEqual(expect.arrayContaining(['metadata', 'last_seen_at', 'source', 'connection_state', 'connection_reason']));
});
