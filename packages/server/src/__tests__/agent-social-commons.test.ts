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

  it('turns agent interests into bounded peer challenges and proposals into governed candidates', () => {
    comms.socialize(0);
    const [question] = comms.receiveSocial('agent-b');
    expect(question.payload.params.ecosystem_context).toContain('Paperclip');
    const reply = {
      answer: 'Let peers compare retrieval failures.', uncertainty: 'No live measurements yet.',
      falsifiable_next_step: 'Compare ten known queries against the baseline.', creative_alternative: 'Try a blinded query set.',
      stop_condition: 'Stop if recall regresses.', runtime: 'opencode', model_id: 'model-b',
      interest: 'Could peers identify missing retrieval evidence?', ecosystem_component: 'DjimitKBWiki',
      proposed_improvement: 'Add a retrieval evidence comparison view.', delivery_lease_token: question.deliveryLeaseToken,
    };
    const response = comms.respondSocial('agent-b', question.id, reply);
    expect(db.prepare('SELECT COUNT(*) AS n FROM self_improvements').get()).toEqual({ n: 0 });
    const peerResponse = comms.receiveSocial('agent-a').find((m) => m.id === response.message.id)!;
    expect(peerResponse.payload.params.interest).toBe(reply.interest);
    const learning = comms.respondSocial('agent-a', peerResponse.id, { ...reply, interest: '', delivery_lease_token: peerResponse.deliveryLeaseToken });
    const proposal = db.prepare('SELECT * FROM self_improvements').get() as any;
    expect(proposal.status).toBe('proposed');
    expect(proposal.approved_by).toBeNull();
    expect(proposal.description).toContain(reply.falsifiable_next_step);
    expect(JSON.parse(proposal.evidence_refs_json)).toContain(`reflection:${learning.reflection_id}`);
    expect(learning.message.payload.params.improvement_id).toBe(proposal.id);
    expect(db.prepare('SELECT status FROM specialist_panels WHERE id = ?').get(proposal.panel_id)).toEqual({ status: 'planned' });
    const reflection = db.prepare('SELECT status, metadata FROM reflection_candidates WHERE id = ?').get(learning.reflection_id) as any;
    expect(reflection.status).toBe('candidate');
    expect(JSON.parse(reflection.metadata)).toMatchObject({ candidate_only: true, promotion_allowed: false });
    expect(comms.respondSocial('agent-a', peerResponse.id, { ...reply, delivery_lease_token: peerResponse.deliveryLeaseToken }).duplicate).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM self_improvements').get()).toEqual({ n: 1 });
    const nextRound = comms.socialize(0);
    expect(nextRound.topic).toBe(reply.interest);
    expect(nextRound.messages[0].payload.params.topic_ref).toBe(`message:${response.message.id}`);
    expect(nextRound.messages[0].payload.params.ecosystem_component).toBe('DjimitKBWiki');
    expect(comms.socialize(0).topic).not.toBe(reply.interest);
    const projected = comms.listSocialCommons().threads.flatMap((t) => t.messages).find((m) => m.id === learning.message.id)!;
    expect(projected.improvement_id).toBe(proposal.id);
    expect(projected.improvement_status).toBe('proposed');
    expect(projected.provenance_status).toBe('runtime_reported');
  });

  it('links distinct peer learnings to the same active proposal without duplicating review panels', () => {
    const round = comms.socialize(0);
    const reply = { answer: 'An unverified idea', uncertainty: 'Needs evidence', falsifiable_next_step: 'Compare with baseline',
      creative_alternative: 'Blind comparison', stop_condition: 'Any regression', ecosystem_component: 'Djimitflo',
      proposed_improvement: 'Add a peer comparison view', runtime: 'test-runtime', model_id: 'test-model' };
    for (const agent of round.participants) {
      const [question] = comms.receiveSocial(agent, 1).filter(m => m.payload.action === 'social.question');
      comms.respondSocial(agent, question.id, { ...reply, delivery_lease_token: question.deliveryLeaseToken });
    }
    const learnings = round.participants.map(agent => {
      const [response] = comms.receiveSocial(agent).filter(m => m.payload.action === 'social.response');
      return comms.respondSocial(agent, response.id, { ...reply, delivery_lease_token: response.deliveryLeaseToken });
    });
    expect(learnings[0].message.id).not.toBe(learnings[1].message.id);
    expect(learnings[0].reflection_id).not.toBe(learnings[1].reflection_id);
    expect(learnings[0].message.payload.params.improvement_id).toBeTruthy();
    expect(learnings[1].message.payload.params.improvement_id).toBe(learnings[0].message.payload.params.improvement_id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM self_improvements').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM specialist_panels').get()).toEqual({ n: 1 });
  });

  it('requires component context before accepting an improvement and leaves its lease usable', () => {
    comms.socialize(0);
    const [question] = comms.receiveSocial('agent-b');
    expect(() => comms.respondSocial('agent-b', question.id, {
      answer: 'An idea', uncertainty: 'Unknown', falsifiable_next_step: 'Test', creative_alternative: 'Other',
      stop_condition: 'Failure', proposed_improvement: 'Add a view', delivery_lease_token: question.deliveryLeaseToken,
    })).toThrow('SOCIAL_COMPONENT_REQUIRED');
    expect(db.prepare('SELECT status FROM agent_messages WHERE id = ?').get(question.id)).toEqual({ status: 'delivered' });
  });

  it('seeks out peers that have not met before the same pair talks again', () => {
    db.prepare("INSERT INTO agents (id, name, status, capabilities_json) VALUES ('agent-c', 'Agent C', 'active', '[]')").run();
    comms.heartbeat('agent-c', 'ollama', 'test-model');
    expect(comms.socialize(0).participants).toEqual(['agent-a', 'agent-b']);
    const second = comms.socialize(0);
    expect(second.status).toBe('started');
    expect(second.participants).toContain('agent-c');
  });

  it('varies the topic: open gap first, then an unchallenged lesson, then rotating curiosity seeds', () => {
    const answer = (agentId: string, message: { id: string; deliveryLeaseToken?: string }) => comms.respondSocial(agentId, message.id, {
      answer: 'Lesson: cite before you claim.', uncertainty: 'u', falsifiable_next_step: 'f', creative_alternative: 'c', stop_condition: 's',
      runtime: 'test-runtime', model_id: 'test-model', delivery_lease_token: message.deliveryLeaseToken,
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

  it('shows non-social agent activity in the commons read-model', () => {
    comms.send({ from: 'agent-a', to: 'agent-b', type: 'task', action: 'task.assigned', context: 'Review OKF index' });

    const commons = comms.listSocialCommons();
    const agentA = commons.agents.find((agent) => agent.id === 'agent-a');
    expect(agentA?.activity).toHaveLength(1);
    expect(agentA?.activity[0]).toEqual(expect.objectContaining({ to: 'agent-b', action: 'task.assigned' }));

    // social messages stay in threads; non-social messages do not leak into threads.
    comms.socialize(0);
    const commons2 = comms.listSocialCommons();
    const [thread] = commons2.threads;
    expect(thread.messages.map((message) => message.action)).toEqual(['social.question', 'social.question']);
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
