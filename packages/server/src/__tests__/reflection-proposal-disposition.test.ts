// AC-10: why a Commons conversation stays a reflection instead of becoming a proposal — effective policy + per-decision reason.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AgentCommunicationService } from '../services/agent-communication-service';
import { reflectionProposalPolicy, REFLECTION_PROPOSAL_DISPOSITION, SelfImprovementService } from '../services/self-improvement-service';

let db: Database.Database;
const DAY = 86_400_000;
const input = (text = 'Fix the fixture error handling') => ({ whatFailed: [], lessonsLearned: ['unverified'], proposedImprovements: [text] });
const seedReflection = (id: string, createdAt: string, source = 'reflection') => db.prepare(`INSERT INTO self_improvements
  (id, type, title, description, rationale, source, status, priority, created_at, updated_at) VALUES (?, 'feature', ?, 'd', 'r', ?, 'needs_grounding', 0.5, ?, ?)`)
  .run(id, `seed ${id}`, source, createdAt, createdAt);
const dispositionRows = () => db.prepare('SELECT subject_id, decision, answers_json FROM judgments WHERE judgment = ? ORDER BY created_at')
  .all(REFLECTION_PROPOSAL_DISPOSITION) as Array<{ subject_id: string; decision: string; answers_json: string }>;

beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  vi.stubEnv('REFLECTION_PROPOSALS_MAX_PER_DAY', undefined as unknown as string);
  vi.stubEnv('PROPOSAL_GROUNDING_REQUIRED', 'false');
  for (const id of ['a', 'b']) db.prepare("INSERT INTO agents(id,name,description,status,capabilities,metadata) VALUES (?,?,'fixture','active','[]','{}')").run(id, id);
});
afterEach(() => { db.close(); vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });

/** One Commons learning reply (social.response → social.learning), as the audit fixture does. */
function learn(comms: AgentCommunicationService, overrides: Record<string, unknown> = {}, thread = 'social:policy', topicRef?: string) {
  const sent = comms.send({ from: 'b', to: 'a', type: 'result', action: 'social.response', context: 'unverified hypothesis', evidence: ['file:known.ts'], threadId: thread, ttl: 3600,
    params: { topic: 'bounded diagnosis', ecosystem_component: 'DjimitFlo', ...(topicRef ? { topic_ref: topicRef } : {}) } });
  const [message] = comms.receiveSocial('a', 10).filter((m) => m.id === sent.id);
  const reply = { answer: 'An untested diagnostic hypothesis', uncertainty: 'No execution evidence yet', falsifiable_next_step: 'Compare on an isolated case',
    creative_alternative: 'Keep current behaviour', stop_condition: 'Stop if contradicted', proposed_improvement: 'Fix the fixture error handling',
    ecosystem_component: 'DjimitFlo', evidence_refs: ['file:known.ts'], runtime: 'mock', model_id: 'mock', delivery_lease_token: message.deliveryLeaseToken, ...overrides };
  return { original: message, reply, out: comms.respondSocial('a', message.id, reply) };
}
const projected = (comms: AgentCommunicationService, id: string) => comms.listSocialCommons().threads.flatMap((t) => t.messages).find((m) => m.id === id)!;

describe('effective reflection-proposal policy (read model)', () => {
  it.each([
    ['0', 0, 'disabled', 0],
    ['2', 0, 'open', 2],
    ['1', 1, 'exhausted', 0],
    [undefined, 3, 'uncapped', null],
  ] as const)('cap %s with %i in the window is %s', (cap, seeded, state, remaining) => {
    if (cap !== undefined) vi.stubEnv('REFLECTION_PROPOSALS_MAX_PER_DAY', cap);
    for (let i = 0; i < seeded; i += 1) seedReflection(`r${i}`, new Date().toISOString());
    const policy = reflectionProposalPolicy(db);
    expect(policy).toMatchObject({ env: 'REFLECTION_PROPOSALS_MAX_PER_DAY', cap: cap === undefined ? null : Number(cap), state, remaining,
      created_in_window: seeded, window: 'rolling_24h', window_hours: 24, scope: 'global', source: 'reflection' });
    expect(policy.shared_producers).toEqual(['commons_social_learning', 'continuous_learning_loop', 'memory_candidate_review']);
  });

  it('is on the Commons read model with the disabled workers and without any other env value', () => {
    vi.stubEnv('REFLECTION_PROPOSALS_MAX_PER_DAY', '0');
    vi.stubEnv('COMMONS_PROPOSAL_REVIEW_ENABLED', 'false');
    vi.stubEnv('COMMONS_AGENDA_GROUNDING', 'true');
    vi.stubEnv('LITELLM_API_KEY', 'sk-secret-should-not-leak');
    const commons = new AgentCommunicationService(db).listSocialCommons();
    expect(commons.proposal_policy).toMatchObject({ cap: 0, state: 'disabled', scope: 'global', source: 'reflection', window: 'rolling_24h' });
    expect(commons.proposal_policy?.workers).toEqual(expect.arrayContaining([
      { id: 'commons_proposal_review', env: 'COMMONS_PROPOSAL_REVIEW_ENABLED', enabled: false },
      { id: 'grounding_agenda', env: 'COMMONS_AGENDA_GROUNDING', enabled: true },
      { id: 'grounding_apply', env: 'COMMONS_GROUNDING_APPLY', enabled: false },
      { id: 'failure_agenda', env: 'COMMONS_AGENDA_FROM_FAILURES', enabled: false },
    ]));
    expect(JSON.stringify(commons)).not.toContain('sk-secret');
  });
});

describe('typed reflection→proposal decision (SelfImprovementService)', () => {
  it('keeps the quota count unknown when its query fails', () => {
    const service = new SelfImprovementService(db);
    db.exec('DROP TABLE self_improvements');
    const failed = service.decideFromReflection(input());
    expect(failed).toMatchObject({ failed: true, proposals: [], decisions: [{ reason: 'runtime_failure', created_in_window: null }] });
  });

  it('cap 0 → policy_disabled; positive cap → created; exhausted → rate_limited; unset → created with cap null', () => {
    const service = new SelfImprovementService(db);
    vi.stubEnv('REFLECTION_PROPOSALS_MAX_PER_DAY', '0');
    expect(service.decideFromReflection(input('Fix A in x'))).toMatchObject({ proposals: [], failed: false,
      decisions: [{ reason: 'policy_disabled', proposal_id: null, cap: 0, created_in_window: 0, window: 'rolling_24h', scope: 'global', source: 'reflection' }] });
    vi.stubEnv('REFLECTION_PROPOSALS_MAX_PER_DAY', '1');
    const created = service.decideFromReflection(input('Fix B in y'));
    expect(created.decisions).toEqual([expect.objectContaining({ reason: 'created', proposal_id: created.proposals[0].id, cap: 1, created_in_window: 0 })]);
    expect(service.decideFromReflection(input('Fix C in z')).decisions).toEqual([expect.objectContaining({ reason: 'rate_limited', proposal_id: null, cap: 1, created_in_window: 1 })]);
    vi.stubEnv('REFLECTION_PROPOSALS_MAX_PER_DAY', undefined as unknown as string);
    expect(service.decideFromReflection(input('Fix D in w')).decisions).toEqual([expect.objectContaining({ reason: 'created', cap: null })]);
  });

  it('an ungrounded proposal under PROPOSAL_GROUNDING_REQUIRED is pending_grounding with its id', () => {
    vi.stubEnv('PROPOSAL_GROUNDING_REQUIRED', 'true');
    const out = new SelfImprovementService(db).decideFromReflection(input('Improve things somewhere'));
    expect(out.proposals[0].status).toBe('needs_grounding');
    expect(out.decisions).toEqual([expect.objectContaining({ reason: 'pending_grounding', proposal_id: out.proposals[0].id })]);
  });

  it('counts the rolling 24 h window: exactly 24 h old still counts, 1 ms older does not', () => {
    const now = Date.parse('2026-10-24T12:00:00.000Z');
    vi.useFakeTimers({ now, toFake: ['Date'] });
    vi.stubEnv('REFLECTION_PROPOSALS_MAX_PER_DAY', '1');
    seedReflection('edge', new Date(now - DAY).toISOString());
    const service = new SelfImprovementService(db);
    expect(service.decideFromReflection(input('Fix E')).decisions[0]).toMatchObject({ reason: 'rate_limited', created_in_window: 1 });
    db.prepare('UPDATE self_improvements SET created_at = ? WHERE id = ?').run(new Date(now - DAY - 1).toISOString(), 'edge');
    expect(service.decideFromReflection(input('Fix E')).decisions[0]).toMatchObject({ reason: 'created', created_in_window: 0 });
  });

  it('duplicate links the existing candidate only with includeExisting, and creates nothing either way', () => {
    const service = new SelfImprovementService(db);
    const [first] = service.generateFromReflection(input('Fix the same thing'));
    expect(service.decideFromReflection(input('Fix the same thing'), true)).toMatchObject({ proposals: [{ id: first.id }], decisions: [{ reason: 'duplicate', proposal_id: first.id }] });
    expect(service.decideFromReflection(input('Fix the same thing'), false)).toMatchObject({ proposals: [], decisions: [{ reason: 'duplicate', proposal_id: null }] });
    expect((db.prepare('SELECT COUNT(*) n FROM self_improvements').get() as { n: number }).n).toBe(1);
  });

  it('the compatibility method returns exactly the proposals of the decision and still throws a runtime failure', () => {
    const service = new SelfImprovementService(db);
    vi.stubEnv('REFLECTION_PROPOSALS_MAX_PER_DAY', '2');
    const made = service.generateFromReflection({ ...input(), proposedImprovements: ['Fix A in x', 'Fix B in y', 'Fix C in z'] });
    expect(made.map((p) => p.title)).toEqual(['Fix A in x', 'Fix B in y']);
    vi.spyOn(service as unknown as { createProposalWithOutcome: () => unknown }, 'createProposalWithOutcome').mockImplementation(() => { throw new Error('SELF_IMPROVEMENT_TEST_FAILURE'); });
    vi.stubEnv('REFLECTION_PROPOSALS_MAX_PER_DAY', undefined as unknown as string);
    const failed = service.decideFromReflection(input('Fix F'));
    expect(failed).toMatchObject({ failed: true, proposals: [], decisions: [{ reason: 'runtime_failure', proposal_id: null, error_code: 'SELF_IMPROVEMENT_TEST_FAILURE' }] });
    expect(() => service.generateFromReflection(input('Fix F'))).toThrow('SELF_IMPROVEMENT_TEST_FAILURE');
  });
});

describe('Commons learning → recorded disposition', () => {
  it('cap 0: reflection recorded, no proposal, one disposition row shown on the message', () => {
    vi.stubEnv('REFLECTION_PROPOSALS_MAX_PER_DAY', '0');
    const comms = new AgentCommunicationService(db);
    const { out } = learn(comms);
    expect(out.reflection_id).toBeTruthy();
    expect(out.message.payload.params.improvement_id ?? null).toBeNull();
    expect(dispositionRows()).toEqual([expect.objectContaining({ subject_id: out.message.id, decision: 'policy_disabled' })]);
    expect(projected(comms, out.message.id).proposal_disposition).toMatchObject({ reason: 'policy_disabled', proposal_id: null, cap: 0, window: 'rolling_24h', scope: 'global', source: 'reflection' });
  });

  it('shared-source cohort: a reflection proposal from another producer exhausts the Commons cap; other sources do not', () => {
    vi.stubEnv('REFLECTION_PROPOSALS_MAX_PER_DAY', '1');
    const service = new SelfImprovementService(db);
    service.generateFromGaps([{ domain: 'x', description: 'a gap-analysis proposal does not share the reflection cap' }]);
    expect(reflectionProposalPolicy(db)).toMatchObject({ state: 'open', created_in_window: 0 });
    service.generateFromReflection({ whatFailed: ['loop run failed'], lessonsLearned: [], proposedImprovements: ['Loop-run reflection proposal'] }); // continuous-learning-loop shape
    const comms = new AgentCommunicationService(db);
    const { out } = learn(comms);
    expect(out.message.payload.params.improvement_id ?? null).toBeNull();
    expect(projected(comms, out.message.id).proposal_disposition).toMatchObject({ reason: 'rate_limited', cap: 1, created_in_window: 1 });
  });

  it('duplicate on the Commons path keeps linking the existing candidate (includeExisting=true)', () => {
    const comms = new AgentCommunicationService(db);
    const first = learn(comms, {}, 'social:one').out;
    const second = learn(comms, {}, 'social:two').out;
    const id = first.message.payload.params.improvement_id;
    expect(id).toBeTruthy();
    expect(second.message.payload.params.improvement_id).toBe(id);
    expect(projected(comms, first.message.id).proposal_disposition).toMatchObject({ reason: 'created', proposal_id: id });
    expect(projected(comms, second.message.id).proposal_disposition).toMatchObject({ reason: 'duplicate', proposal_id: id });
  });

  it('an idempotent retry of the same reply records no second decision', () => {
    vi.stubEnv('REFLECTION_PROPOSALS_MAX_PER_DAY', '0');
    const comms = new AgentCommunicationService(db);
    const { original, reply, out } = learn(comms);
    const again = comms.respondSocial('a', original.id, reply);
    expect(again).toMatchObject({ duplicate: true, message: { id: out.message.id } });
    expect(dispositionRows()).toHaveLength(1);
  });

  it('a learning without an improvement, or on a proposal-review thread, records not_applicable — never a proposal', () => {
    const comms = new AgentCommunicationService(db);
    const plain = learn(comms, { proposed_improvement: '' }, 'social:plain').out;
    const review = learn(comms, {}, 'social:review', 'improvement:some-id').out;
    expect(projected(comms, plain.message.id).proposal_disposition).toMatchObject({ reason: 'not_applicable', detail: 'no_proposed_improvement' });
    expect(projected(comms, review.message.id).proposal_disposition).toMatchObject({ reason: 'not_applicable', detail: 'proposal_review_thread' });
    expect((db.prepare('SELECT COUNT(*) n FROM self_improvements').get() as { n: number }).n).toBe(0);
  });

  it('a runtime failure still rolls the reply back and throws, and the failure is recorded on the replied-to message', () => {
    const comms = new AgentCommunicationService(db);
    vi.spyOn(SelfImprovementService.prototype as unknown as { createProposalWithOutcome: () => unknown }, 'createProposalWithOutcome')
      .mockImplementation(() => { throw new Error('SELF_IMPROVEMENT_TEST_FAILURE'); });
    expect(() => learn(comms)).toThrow('SELF_IMPROVEMENT_TEST_FAILURE');
    expect(db.prepare("SELECT COUNT(*) n FROM agent_messages WHERE json_extract(payload_json, '$.action') = 'social.learning'").get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) n FROM reflection_candidates').get()).toEqual({ n: 0 });
    const [row] = dispositionRows();
    expect(row.decision).toBe('runtime_failure');
    const original = db.prepare("SELECT id FROM agent_messages WHERE json_extract(payload_json, '$.action') = 'social.response'").get() as { id: string };
    expect(row.subject_id).toBe(original.id);
    expect(projected(comms, original.id).proposal_disposition).toMatchObject({ reason: 'runtime_failure', error_code: 'SELF_IMPROVEMENT_TEST_FAILURE' });
  });

  it('a historical learning without a recorded decision reads unknown — no reason is inferred from the current cap', () => {
    vi.stubEnv('REFLECTION_PROPOSALS_MAX_PER_DAY', '0');
    const comms = new AgentCommunicationService(db);
    const old = comms.send({ from: 'a', to: 'b', type: 'knowledge', action: 'social.learning', context: 'old lesson', evidence: ['message:x'], threadId: 'social:old', epistemicRole: 'outcome', ttl: 3600,
      params: { proposed_improvement: 'An old idea', ecosystem_component: 'DjimitFlo' } });
    const view = projected(comms, old.id);
    expect(view.proposal_disposition).toMatchObject({ reason: 'unknown', proposal_id: null, decided_at: null, cap: null });
    expect(dispositionRows()).toHaveLength(0);
  });
});
