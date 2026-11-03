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
    comms.heartbeat('agent-a', 'codex', 'model-a', 'runtime_token');
    comms.heartbeat('agent-b', 'opencode', 'model-b', 'runtime_token');
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
    // totals come from the server, not from the loaded page (prod 2026-09-24: "Reflecties 40" was the page size)
    expect(commons.stats).toMatchObject({ threads_7d: 1, open_7d: 0, learnings_7d: 1, proposals_verified: 0 });
  });

  it('turns agent interests into bounded peer challenges and proposals into governed candidates', () => {
    comms.socialize(0);
    const [question] = comms.receiveSocial('agent-b');
    expect(question.payload.params.ecosystem_context).toContain('the core (work control, approvals');
    expect(question.payload.params.ecosystem_context).not.toContain('Paperclip');
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
    comms.heartbeat('agent-c', 'ollama', 'test-model', 'runtime_token');
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
    // a gap is discussed once: the next round moves on instead of re-picking the newest gap (prod: 264 repeated threads)
    expect(comms.socialize(0).topic).not.toBe('The OKF index lacks provenance for imported skills');
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

// AC-02: record-only evidence rooms (42 of the newest 50 threads in prod, 24-10) must not push real discussions out of the feed.
describe('agent commons feed: discussions vs record-only rooms (AC-02)', () => {
  let db: Database.Database;
  let comms: AgentCommunicationService;
  beforeEach(() => { db = createTestDb(); comms = new AgentCommunicationService(db); });
  afterEach(() => db.close());

  const post = (from: string, to: string, threadId: string, at: string) => {
    const message = comms.send({ from, to, type: 'question', action: 'social.question', context: threadId, evidence: ['e'], threadId,
      epistemicRole: 'question', ttl: 86_400, params: { topic: threadId, topic_ref: threadId } });
    db.prepare('UPDATE agent_messages SET timestamp = ? WHERE id = ?').run(at, message.id);
  };
  const seed = () => {
    post('agent-a', 'agent-b', 'social:real-discussion', '2026-10-01T00:00:00.000Z');
    for (let i = 0; i < 51; i += 1) post('djimitflo:evidence-room', 'commons', `evidence-room:run-${i}`, new Date(Date.parse('2026-10-02T00:00:00.000Z') + i * 60_000).toISOString());
  };

  it('a 52-thread replay with 51 newer records still shows the real discussion in the Discussion view', () => {
    seed();
    const discussion = comms.listSocialCommons(50, { kind: 'discussion' });
    expect(discussion.threads.map((t) => t.id)).toEqual(['social:real-discussion']);
    expect(discussion.threads[0].kind).toBe('discussion');
    expect(discussion.thread_counts).toEqual({ discussion: 1, record: 51 });
    expect(discussion.total_threads).toBe(52);
    expect(discussion.page).toEqual({ kind: 'discussion', limit: 50, offset: 0, total: 1, has_more: false });

    const records = comms.listSocialCommons(50, { kind: 'record' });
    expect(records.threads).toHaveLength(50);
    expect(records.threads.every((t) => t.kind === 'record')).toBe(true);
    expect(records.page).toMatchObject({ kind: 'record', total: 51, has_more: true });
    // bounded paging: the 51st (oldest) room is on the next page
    const next = comms.listSocialCommons(50, { kind: 'record', offset: 50 });
    expect(next.threads.map((t) => t.id)).toEqual(['evidence-room:run-0']);
    expect(next.page).toMatchObject({ offset: 50, has_more: false });
  });

  it('keeps the default (no kind) API compatible: newest threads of every kind', () => {
    seed();
    const all = comms.listSocialCommons(50);
    expect(all.threads).toHaveLength(50);
    expect(all.threads.some((t) => t.id === 'social:real-discussion')).toBe(false);
    expect(all.page).toMatchObject({ kind: 'all', total: 52, has_more: true });
  });

  it('the route passes kind/offset through, bounded, and ignores unknown kinds', async () => {
    const { default: express } = await import('express');
    const { default: request } = await import('supertest');
    const { createSwarmOrchestrationRoutes } = await import('../routes/swarm-orchestration');
    seed();
    const auth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use(express.json()).use('/swarm', createSwarmOrchestrationRoutes(db, auth));
    const discussion = await request(app).get('/swarm/social/commons?limit=20&kind=discussion');
    expect(discussion.body.threads.map((t: { id: string }) => t.id)).toEqual(['social:real-discussion']);
    const paged = await request(app).get('/swarm/social/commons?limit=20&kind=record&offset=999999999');
    expect(paged.body.page).toMatchObject({ kind: 'record', offset: 100_000, has_more: false });
    expect(paged.body.threads).toEqual([]);
    const unknown = await request(app).get('/swarm/social/commons?limit=20&kind=bogus');
    expect(unknown.body.page.kind).toBe('all');
  });
});

// AC-01: heartbeat = the poller/API path is alive; it is not readiness to answer (prod 24-10: Hermes heartbeats, last reply 18-10).
describe('agent commons runtime readiness (AC-01)', () => {
  let db: Database.Database;
  let comms: AgentCommunicationService;
  const reply = { answer: 'Run a control.', uncertainty: 'Unknown effect size.', falsifiable_next_step: 'Run the control.',
    creative_alternative: 'Blind the evaluator.', stop_condition: 'Identical outcomes.', runtime: 'hermes', model_id: 'model-b' };
  const readiness = (id: string) => comms.listSocialCommons().agents.find((agent) => agent.id === id)!.readiness;

  beforeEach(() => {
    db = createTestDb();
    db.prepare("INSERT INTO agents (id, name, status, capabilities_json) VALUES ('agent-a', 'Agent A', 'active', '[]'), ('agent-b', 'Agent B', 'active', '[]')").run();
    comms = new AgentCommunicationService(db);
    comms.heartbeat('agent-a', 'codex', 'model-a', 'runtime_token');
    comms.heartbeat('agent-b', 'hermes', 'model-b', 'runtime_token');
  });
  afterEach(() => db.close());

  it('heartbeat fresh but no successful reply is degraded, not ready; failures are not reported by the runtime', () => {
    const b = readiness('agent-b');
    expect(b.state).toBe('degraded');
    expect(b.last_heartbeat_at).toBeTruthy();
    expect(b.last_successful_reply_at).toBeNull();
    expect(b.last_failed_attempt).toBeNull();
    expect(b.runtime_failures_reported).toBe(false);
  });

  it('a claimed question whose lease lapsed without a reply is a failed attempt; resumed success makes it ready without a duplicate reply', () => {
    comms.socialize(0);
    const [question] = comms.receiveSocial('agent-b');
    // the poller claimed it, the child exited non-zero, nothing was posted: the lease lapses
    db.prepare('UPDATE agent_messages SET delivery_lease_until = ? WHERE id = ?').run(Date.now() - 60_000, question.id);
    const failing = readiness('agent-b');
    expect(failing.state).toBe('degraded');
    expect(failing.last_failed_attempt).toMatchObject({ message_id: question.id, observed: 'claim_lapsed_without_reply' });
    expect(failing.runtime_failures_reported).toBe(false);

    const [again] = comms.receiveSocial('agent-b');
    expect(again.id).toBe(question.id);
    comms.respondSocial('agent-b', again.id, { ...reply, delivery_lease_token: again.deliveryLeaseToken });
    expect(comms.respondSocial('agent-b', again.id, { ...reply, delivery_lease_token: again.deliveryLeaseToken }).duplicate).toBe(true);
    const resumed = readiness('agent-b');
    expect(resumed.state).toBe('ready');
    expect(resumed.last_successful_reply_at).toBeTruthy();
    expect(resumed.last_failed_attempt).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE from_agent = 'agent-b' AND json_extract(payload_json, '$.action') = 'social.response'").get()).toEqual({ n: 1 });
  });

  it('a lapse after the last successful reply degrades again; an older lapse does not', () => {
    comms.socialize(0);
    const [first] = comms.receiveSocial('agent-b');
    comms.respondSocial('agent-b', first.id, { ...reply, delivery_lease_token: first.deliveryLeaseToken });
    db.prepare("UPDATE agent_messages SET timestamp = ? WHERE from_agent = 'agent-b'").run(new Date(Date.now() - 3_600_000).toISOString());
    comms.socialize(0);
    const [second] = comms.receiveSocial('agent-b').filter((m) => m.id !== first.id && m.payload.action === 'social.question');
    db.prepare('UPDATE agent_messages SET delivery_lease_until = ? WHERE id = ?').run(Date.now() - 60_000, second.id);
    expect(readiness('agent-b')).toMatchObject({ state: 'degraded', last_failed_attempt: { message_id: second.id } });
    db.prepare('UPDATE agent_messages SET delivery_lease_until = ? WHERE id = ?').run(Date.now() - 7_200_000, second.id);
    expect(readiness('agent-b').state).toBe('ready');
  });

  it('a stale heartbeat is offline and an agent that never sent one is unknown', () => {
    const stale = new Date(Date.now() - 3_600_000).toISOString();
    const metadata = JSON.parse((db.prepare("SELECT metadata FROM agents WHERE id = 'agent-a'").get() as { metadata: string }).metadata);
    metadata.social_runtime.last_heartbeat_at = stale;
    db.prepare("UPDATE agents SET metadata = ? WHERE id = 'agent-a'").run(JSON.stringify(metadata));
    expect(readiness('agent-a').state).toBe('offline');
    delete metadata.social_runtime.last_heartbeat_at;
    db.prepare("UPDATE agents SET metadata = ? WHERE id = 'agent-a'").run(JSON.stringify(metadata));
    expect(readiness('agent-a').state).toBe('unknown');
  });
});
