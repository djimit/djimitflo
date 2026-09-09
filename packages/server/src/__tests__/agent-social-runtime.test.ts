import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type Database from 'better-sqlite3';
import { createAgentSocialRuntimeRoutes } from '../routes/swarm-orchestration';
import { AgentCommunicationService } from '../services/agent-communication-service';
import { mintSpawnToken } from '../services/spawn-token';
import { createTestDb } from './helpers/test-db';

describe('signed agent social runtime', () => {
  let db: Database.Database;
  let server: Server;
  let base: string;
  const secret = 'test-social-runtime-secret-with-enough-entropy';

  beforeEach(async () => {
    process.env.JWT_SECRET = secret;
    db = createTestDb();
    db.prepare("INSERT INTO agents (id, name, status) VALUES ('agent-a', 'Agent A', 'active'), ('agent-b', 'Agent B', 'active')").run();
    new AgentCommunicationService(db).send({
      from: 'agent-a', to: 'agent-b', type: 'question', action: 'social.question',
      context: 'Inspect api_key=abcdefghijklmnop before answering.', evidence: ['claim:gap'],
      params: { topic: 'Test gap' }, threadId: 'social:test', epistemicRole: 'question',
    });
    db.prepare(`INSERT INTO agent_messages (id, from_agent, to_agent, type, payload_json, timestamp, ttl, status)
      VALUES ('legacy-social', 'agent-a', 'agent-b', 'question', ?, datetime('now'), 86400, 'pending')`)
      .run(JSON.stringify({ action: 'social.question', params: { correlation_id: 'legacy-thread' } }));
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

  it('keeps agent scope, lease fencing and candidate learning intact', async () => {
    const tokenA = mintSpawnToken(secret, 'agent-a', 'social-runtime', 60_000);
    const tokenB = mintSpawnToken(secret, 'agent-b', 'social-runtime', 60_000);
    expect((await fetch(`${base}/agent-b/messages`)).status).toBe(401);
    expect((await fetch(`${base}/agent-a/messages`, { headers: { 'X-Agent-Social-Token': tokenB } })).status).toBe(401);
    expect((await fetch(`${base}/agent-b/heartbeat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Social-Token': tokenB }, body: '{}',
    })).status).toBe(400);

    const heartbeat = await fetch(`${base}/agent-b/heartbeat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Social-Token': tokenB },
      body: JSON.stringify({ runtime: 'test-runtime', model_id: 'test-model' }),
    });
    expect(heartbeat.status).toBe(200);
    const messagesResponse = await fetch(`${base}/agent-b/messages`, { headers: { 'X-Agent-Social-Token': tokenB } });
    const received = (await messagesResponse.json()).messages;
    expect(received).toHaveLength(1);
    const [question] = received;
    expect(question.id).not.toBe('legacy-social');
    expect(question.payload.context).toContain('[REDACTED:Generic Secret]');
    expect(question.payload.context).not.toContain('abcdefghijklmnop');
    expect(question.deliveryLeaseToken).toBeTruthy();

    const responseBody = {
      answer: 'Use a negative control.', uncertainty: 'Effect size is unknown.',
      falsifiable_next_step: 'Run the control.', creative_alternative: 'Blind the evaluator.',
      stop_condition: 'Stop if outcomes are identical.', evidence_refs: ['claim:gap'],
      runtime: 'test-runtime', model_id: 'test-model', runtime_run_id: 'run-1',
      delivery_lease_token: question.deliveryLeaseToken,
    };
    const responseUrl = `${base}/agent-b/messages/${question.id}/respond`;
    const response = await fetch(responseUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Social-Token': tokenB }, body: JSON.stringify(responseBody),
    });
    const responseJson = await response.json();
    expect(response.status).toBe(201);
    expect(responseJson.message.payload).toMatchObject({
      action: 'social.response', thread_id: 'social:test', reply_to: question.id, epistemic_role: 'proposal',
      params: { effect_scope: 'isolated', external_side_effects: false, response_kind: 'actual_runtime' },
    });
    expect((await fetch(responseUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Social-Token': tokenB }, body: JSON.stringify(responseBody),
    })).status).toBe(200);

    const peerMessages = await fetch(`${base}/agent-a/messages`, { headers: { 'X-Agent-Social-Token': tokenA } });
    const [peerResponse] = (await peerMessages.json()).messages;
    const learning = await fetch(`${base}/agent-a/messages/${peerResponse.id}/respond`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Social-Token': tokenA },
      body: JSON.stringify({ ...responseBody, runtime: 'peer-runtime', delivery_lease_token: peerResponse.deliveryLeaseToken }),
    });
    const learningJson = await learning.json();
    expect(learning.status).toBe(201);
    expect(learningJson).toMatchObject({ reflection_id: expect.any(String), message: { payload: { action: 'social.learning', epistemic_role: 'outcome' } } });
    const reflection = db.prepare('SELECT status, metadata FROM reflection_candidates WHERE id = ?').get(learningJson.reflection_id) as { status: string; metadata: string };
    expect(['candidate', 'review_required']).toContain(reflection.status);
    expect(JSON.parse(reflection.metadata)).toMatchObject({ empirical_status: 'UNDETERMINED', promotion_allowed: false, actual_runtime: true });
  });
});
