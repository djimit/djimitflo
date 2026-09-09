import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import Database from 'better-sqlite3';
import { createAgentSocialRuntimeRoutes } from '../routes/swarm-orchestration';
import { AgentCommunicationService } from '../services/agent-communication-service';
import { mintSpawnToken } from '../services/spawn-token';

describe('signed agent social runtime', () => {
  let db: Database.Database;
  let server: Server;
  let base: string;
  const secret = 'test-social-runtime-secret-with-enough-entropy';

  beforeEach(async () => {
    process.env.JWT_SECRET = secret;
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY, name TEXT, status TEXT, capabilities_json TEXT DEFAULT '[]', metadata TEXT DEFAULT '{}',
        model TEXT, agent_type TEXT, last_heartbeat_at TEXT, last_active_at TEXT, updated_at TEXT, created_at TEXT
      );
      CREATE TABLE reflection_candidates (
        id TEXT PRIMARY KEY, source_type TEXT, source_ref TEXT, lesson TEXT, status TEXT, sensitivity TEXT,
        human_required INTEGER, evidence_refs_json TEXT, metadata TEXT, created_at TEXT, updated_at TEXT
      );
      INSERT INTO agents (id, name, status, updated_at, created_at) VALUES
        ('agent-a', 'Agent A', 'active', datetime('now'), datetime('now')),
        ('agent-b', 'Agent B', 'active', datetime('now'), datetime('now'));
    `);
    const question = new AgentCommunicationService(db).send({
      from: 'agent-a', to: 'agent-b', type: 'question', action: 'social.question',
      context: 'Inspect api_key=abcdefghijklmnop before answering.',
      evidence: ['claim:gap'], params: { correlation_id: 'social:test', topic: 'Test gap' },
    });
    expect(question.status).toBe('pending');
    const app = express();
    app.use(express.json());
    app.use('/social-runtime', createAgentSocialRuntimeRoutes(db));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address();
        base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/social-runtime`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    delete process.env.JWT_SECRET;
  });

  it('enforces agent scope and persists one idempotent isolated runtime response', async () => {
    const token = mintSpawnToken(secret, 'agent-b', 'social-runtime', 60_000);
    expect((await fetch(`${base}/agent-b/messages`)).status).toBe(401);
    expect((await fetch(`${base}/agent-a/messages`, { headers: { 'X-Agent-Social-Token': token } })).status).toBe(401);
    const invalidHeartbeat = await fetch(`${base}/agent-b/heartbeat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Social-Token': token }, body: '{}',
    });
    expect(invalidHeartbeat.status).toBe(400);

    const heartbeat = await fetch(`${base}/agent-b/heartbeat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Social-Token': token },
      body: JSON.stringify({ runtime: 'test-runtime', model_id: 'test-model' }),
    });
    expect(heartbeat.status).toBe(200);
    const messagesResponse = await fetch(`${base}/agent-b/messages`, { headers: { 'X-Agent-Social-Token': token } });
    const messages = (await messagesResponse.json()).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].payload.context).toContain('[REDACTED:Generic Secret]');
    expect(messages[0].payload.context).not.toContain('abcdefghijklmnop');

    const body = {
      answer: 'Use a negative control.', uncertainty: 'Effect size is unknown.',
      falsifiable_next_step: 'Run the control.', creative_alternative: 'Blind the evaluator.',
      stop_condition: 'Stop if outcomes are identical.', evidence_refs: ['claim:gap'],
      runtime: 'test-runtime', model_id: 'test-model', runtime_run_id: 'run-1',
    };
    const url = `${base}/agent-b/messages/${messages[0].id}/respond`;
    const first = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Social-Token': token }, body: JSON.stringify({ ...body, effect_scope: 'production' }) });
    const firstBody = await first.json();
    expect(first.status).toBe(201);
    expect(firstBody.message.payload).toMatchObject({ action: 'social.response', params: { effect_scope: 'isolated', external_side_effects: false, response_kind: 'actual_runtime' } });
    const duplicate = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Social-Token': token }, body: JSON.stringify(body) });
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()).duplicate).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS count FROM agent_messages WHERE json_extract(payload_json, '$.action') = 'social.response'").get()).toEqual({ count: 1 });
  });
});
