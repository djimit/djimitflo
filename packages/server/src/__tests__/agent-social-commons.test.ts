import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { AgentCommunicationService } from '../services/agent-communication-service';
import { createTestDb } from './helpers/test-db';

describe('agent commons read-model', () => {
  let db: Database.Database;
  let comms: AgentCommunicationService;

  beforeEach(() => {
    db = createTestDb();
    db.prepare("INSERT INTO agents (id, name, status, capabilities_json) VALUES ('agent-a', 'Agent A', 'active', '[\"security\"]'), ('agent-b', 'Agent B', 'active', '[\"ux\"]')").run();
    comms = new AgentCommunicationService(db);
    comms.heartbeat('agent-a', 'codex', 'model-a');
    comms.heartbeat('agent-b', 'opencode', 'model-b');
  });

  afterEach(() => db.close());

  it('groups question, response and learning into one thread with presence', () => {
    const round = comms.socialize(0);
    expect(round.status).toBe('started');
    const [questionForB] = comms.receiveSocial('agent-b');
    const reply = {
      answer: 'Token secret=abcdefghijklmnop is not the point; run a control.', uncertainty: 'Unknown effect size.',
      falsifiable_next_step: 'Run the control.', creative_alternative: 'Blind the evaluator.', stop_condition: 'Identical outcomes.',
      runtime: 'opencode', model_id: 'model-b', delivery_lease_token: questionForB.deliveryLeaseToken,
    };
    comms.respondSocial('agent-b', questionForB.id, reply);
    const [responseForA] = comms.receiveSocial('agent-a').filter((message) => message.payload.action === 'social.response');
    comms.respondSocial('agent-a', responseForA.id, { ...reply, runtime: 'codex', model_id: 'model-a', delivery_lease_token: responseForA.deliveryLeaseToken });

    const commons = comms.listSocialCommons();
    expect(commons.agents.map((agent) => [agent.id, agent.present, agent.runtime])).toEqual([['agent-a', true, 'codex'], ['agent-b', true, 'opencode']]);
    expect(commons.threads).toHaveLength(1);
    const [thread] = commons.threads;
    expect(thread.id).toBe(round.correlation_id);
    expect(thread.participants).toEqual(['agent-a', 'agent-b']);
    expect(thread.stage).toBe('learned');
    expect(thread.learnings).toBe(1);
    expect(thread.messages.map((message) => message.action)).toEqual(['social.question', 'social.question', 'social.response', 'social.learning']);
    const learning = thread.messages.at(-1)!;
    expect(learning.reflection_id).toBeTruthy();
    expect(learning.creative_alternative).toBe('Blind the evaluator.');
    expect(learning.answer).not.toContain('abcdefghijklmnop');
  });

  it('seeks out peers that have not met before the same pair talks again', () => {
    db.prepare("INSERT INTO agents (id, name, status, capabilities_json) VALUES ('agent-c', 'Agent C', 'active', '[]')").run();
    comms.heartbeat('agent-c', 'ollama');
    expect(comms.socialize(0).participants).toEqual(['agent-a', 'agent-b']);
    const second = comms.socialize(0);
    expect(second.status).toBe('started');
    expect(second.participants).toContain('agent-c');
  });

  it('varies the topic: open gap first, then an unchallenged lesson, then rotating curiosity seeds', () => {
    const answer = (agentId: string, message: { id: string; deliveryLeaseToken?: string }) => comms.respondSocial(agentId, message.id, {
      answer: 'Lesson: cite before you claim.', uncertainty: 'u', falsifiable_next_step: 'f', creative_alternative: 'c', stop_condition: 's',
      delivery_lease_token: message.deliveryLeaseToken,
    });
    const first = comms.socialize(0);
    expect(first.topic).toBe('cross-agent learning in the Djimit ecosystem');
    const [question] = comms.receiveSocial('agent-b');
    answer('agent-b', question);
    const [response] = comms.receiveSocial('agent-a').filter((message) => message.payload.action === 'social.response');
    answer('agent-a', response);

    const second = comms.socialize(0);
    expect(second.topic).toContain('Challenge this candidate lesson: Lesson: cite before you claim.');
    expect(second.messages[0].payload.params.topic_ref).toMatch(/^reflection:/);
    const third = comms.socialize(0);
    expect(third.topic).not.toBe(second.topic);
    expect(third.topic).not.toBe(first.topic);

    db.prepare(`INSERT INTO swarm_claims (id, claim, predicate, claim_type, subject_ref, evidence_refs_json, status, created_from)
      VALUES ('gap-1', 'The OKF index lacks provenance for imported skills', 'gap', 'hypothesis', 'okf:x', '["okf:x"]', 'proposed', 'test')`).run();
    const fourth = comms.socialize(0);
    expect(fourth.topic).toBe('The OKF index lacks provenance for imported skills');
    expect(fourth.messages[0].payload.evidence).toEqual(['claim:gap-1', 'okf:x']);
  });

  it('reads the production agents schema capability column', () => {
    const productionDb = new Sqlite(':memory:');
    productionDb.exec(`
      CREATE TABLE agents (id TEXT, name TEXT, status TEXT, capabilities TEXT, model TEXT, metadata TEXT);
      CREATE TABLE reflection_candidates (id TEXT, source_type TEXT, source_ref TEXT, status TEXT);
    `);
    productionDb.prepare('INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?)').run(
      'canonical-agent', 'Canonical Agent', 'active', '["research"]', 'model-x',
      JSON.stringify({ social_runtime: { enabled: true, runtime: 'codex', model_id: 'model-x', last_heartbeat_at: new Date().toISOString() } }),
    );

    try {
      const commons = new AgentCommunicationService(productionDb).listSocialCommons();
      expect(commons.agents).toEqual([expect.objectContaining({
        id: 'canonical-agent', capabilities: ['research'], runtime: 'codex', present: true,
      })]);
    } finally {
      productionDb.close();
    }
  });
});
