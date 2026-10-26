import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CommonsProposalDisposition, CommonsProposalPolicy, SocialAgentPresence, SocialMessage, SocialThread } from '../lib/api';
import { agentHue, Constellation, CONSTELLATION_LEGEND, ConstellationEdgeTable, Conversation, GroundedChildOutcomes, layoutConstellation, luredAgents, ProposalPolicyBanner, ReadinessTable, resolveActiveThread, runtimeParticipation } from './AgentCommonsPage';

const agents: SocialAgentPresence[] = [
  { id: 'a', name: 'A', status: 'active', capabilities: [], model: 'm', runtime: 'codex', last_heartbeat_at: null, present: true, activity: [] },
  { id: 'b', name: 'B', status: 'active', capabilities: [], model: 'm', runtime: null, last_heartbeat_at: null, present: false, activity: [] },
];
const thread = (id: string, stage: SocialThread['stage'], participants: string[]): SocialThread => ({
  id, topic: 't', topic_ref: null, participants, stage, started_at: '2026-09-13T10:00:00Z', last_activity_at: '2026-09-13T10:00:00Z', learnings: 0, messages: [], kind: 'discussion',
});

describe('agent commons constellation', () => {
  it('places every agent and thread participant on the ring and keeps the furthest stage per pair', () => {
    const { nodes, edges } = layoutConstellation(agents, [thread('1', 'asked', ['a', 'b']), thread('2', 'learned', ['a', 'b']), thread('3', 'responding', ['b', 'c'])]);
    expect(nodes.map((node) => node.id)).toEqual(['a', 'b', 'c']);
    expect(nodes.every((node) => node.x >= 0 && node.x <= 320 && node.y >= 0 && node.y <= 320)).toBe(true);
    expect(nodes.find((node) => node.id === 'a')).toMatchObject({ present: true, threads: 2 });
    expect(edges).toEqual([
      expect.objectContaining({ from: 'a', to: 'b', count: 2, stage: 'learned' }),
      expect.objectContaining({ from: 'b', to: 'c', count: 1, stage: 'responding' }),
    ]);
  });

  it('draws lured-but-silent agents as hollow nodes until they bite', () => {
    const lures = { probe_count: 0, probes: [], lures: [{ id: 'l', topic: 't', topic_ref: 'r', created_by: 'op', created_at: '', expires_at: '', bites: 1, invitees: [
      { agent_id: 'b', name: 'B', state: 'seen' as const, bit_at: null },
      { agent_id: 'd', name: 'D', state: 'invited' as const, bit_at: null },
      { agent_id: 'a', name: 'A', state: 'bit' as const, bit_at: 'now' },
    ] }] };
    const lured = luredAgents(lures);
    expect([...lured.keys()]).toEqual(['b', 'd']);
    const { nodes } = layoutConstellation(agents, [], 320, lured);
    expect(nodes.map((node) => [node.id, node.lured])).toEqual([['a', false], ['b', true], ['d', true]]);
    expect(nodes.find((node) => node.id === 'd')?.name).toBe('D');
  });

  it('labels edges as same-thread co-participation and lists one row per pair with its shared-thread count', () => {
    const { nodes, edges } = layoutConstellation(agents, [thread('1', 'asked', ['a', 'b']), thread('2', 'learned', ['a', 'b']), thread('3', 'responding', ['b', 'c'])]);
    const table = renderToStaticMarkup(createElement(ConstellationEdgeTable, { nodes, edges }));
    const rows = [...table.matchAll(/<tr[^>]*data-testid="constellation-pair"[^>]*>(.*?)<\/tr>/g)].map((m) => m[1].replace(/<[^>]+>/g, '|').split('|').filter(Boolean));
    expect(rows).toEqual([['A', 'B', '2', 'Reflection'], ['B', 'c', '1', 'In conversation']]);
    expect(table).toContain('Same-thread pairs as a table (2)');
    expect(table).toContain('Shared threads');
    const svg = renderToStaticMarkup(createElement(Constellation, { nodes, edges, focus: null, highlight: [], onSelect: () => undefined }));
    expect(svg).toContain('<title>A and B: same thread, 2 shared threads, furthest stage Reflection</title>');
    expect(svg).toContain('3 agents, 2 same-thread pairs');
    expect(CONSTELLATION_LEGEND).toMatch(/same thread \(co-participation\), not proof that they communicated or learned/);
  });

  it('gives agents a stable hue', () => {
    expect(agentHue('agent-a')).toBe(agentHue('agent-a'));
    expect(agentHue('agent-a')).not.toBe(agentHue('agent-b'));
  });
});

const reply: SocialMessage = {
  id: 'reply', from: 'a', to: 'b', action: 'social.learning', timestamp: '2026-09-13T10:01:00Z',
  status: 'read', reply_to: 'question', text: 'candidate', evidence: [], answer: 'Try a control',
  uncertainty: 'Untested', falsifiable_next_step: 'Compare with baseline', creative_alternative: 'Blind test',
  stop_condition: 'No improvement', runtime: 'claude', model_id: 'model-1', reflection_id: 'reflection-1',
  reflection_status: 'candidate', interest: 'Explore retrieval', ecosystem_component: 'Djimitflo',
  proposed_improvement: 'Add a control group', improvement_id: 'proposal-1', improvement_status: 'proposed',
  runtime_run_id: 'run-1',
};

it('counts submitted runtime replies separately from questions and keeps model provenance', () => {
  const discussion = { ...thread('1', 'learned', ['a', 'b']), messages: [
    reply, { ...reply, id: 'question', action: 'social.question' as const },
    { ...reply, id: 'reply-2', model_id: 'model-2' },
    { ...reply, id: 'unknown', runtime: null },
  ] };
  expect(runtimeParticipation([discussion])).toEqual([
    { agent: 'a', runtime: 'claude', model: 'model-1', replies: 1, lastReply: reply.timestamp },
    { agent: 'a', runtime: 'claude', model: 'model-2', replies: 1, lastReply: reply.timestamp },
  ]);
});

it('renders agent interests and live proposal status without claiming proven learning', () => {
  const discussion = { ...thread('1', 'learned', ['a', 'b']), topic_ref: 'message:prior-reply', messages: [reply] };
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Conversation, { thread: discussion, agents })));
  for (const text of ['Topic raised by an agent', 'Explore retrieval', 'Djimitflo', 'proposal-1', 'proposed', 'reflection candidate', 'run-1']) expect(html).toContain(text);
  expect(html).not.toContain('Learned');
  expect(html).toContain('href="/governance?tab=assurance#improvement-inbox-title"');
  expect(html).toContain('Open review-inbox');
  const suggestion = renderToStaticMarkup(createElement(Conversation, { thread: { ...discussion, messages: [{ ...reply, improvement_id: null }] }, agents }));
  expect(suggestion).toContain('no registered improvement proposal yet');
  expect(suggestion).not.toContain('Open review-inbox');
  const approved = renderToStaticMarkup(createElement(Conversation, { thread: { ...discussion, messages: [{ ...reply, improvement_status: 'approved' }] }, agents }));
  expect(approved).not.toContain('Open review-inbox');
});

it('AC-03: shows the 18 → 0 denominator and keeps technical review failures apart from idea rejections', () => {
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(GroundedChildOutcomes, { outcomes: {
    grounded_proposals: 24, no_refinement: 6, children: 18, legacy_fallback_reviews: 20, note: '',
    outcomes: { technical_failure: 10, needs_evidence: 3, blocked: 2, backlog: 3, goal: 0, pending: 0 },
  } })));
  expect(html).toContain('<strong>18</strong> grounded children → <strong>0</strong> goals');
  expect(html).toContain('technical review failure <strong>10</strong>');
  expect(html).toContain('missing evidence <strong>3</strong>');
  expect(html).toContain('opposed / blocked <strong>2</strong>');
  expect(html).toContain('backlog <strong>3</strong>');
  expect(html).toContain('not a rejected idea');
  expect(html).toContain('href="/#guardrails"');
});

describe('AC-02 record-only rooms and a stable selection', () => {
  it('a record-only evidence room never implies a scheduled reply; an open discussion still waits for a turn', () => {
    const room = { ...thread('evidence-room:r1', 'asked', ['djimitflo:evidence-room', 'commons']), kind: 'record' as const };
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Conversation, { thread: room, agents })));
    expect(html).not.toContain('Waiting for the next runtime turn');
    expect(html).toContain('Record-only evidence room');
    expect(html).toContain('no runtime reply is scheduled');
    const open = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Conversation, { thread: thread('social:1', 'asked', ['a', 'b']), agents })));
    expect(open).toContain('Waiting for the next runtime turn');
  });

  it('keeps the selected thread across a refresh even when it drops off the loaded page', () => {
    const selected = thread('social:old', 'responding', ['a', 'b']);
    const fresh = [thread('social:new', 'asked', ['a', 'b'])];
    expect(resolveActiveThread([selected, ...fresh], 'social:old', null)?.id).toBe('social:old');
    expect(resolveActiveThread(fresh, 'social:old', selected)).toBe(selected);
    expect(resolveActiveThread(fresh, null, selected)?.id).toBe('social:new');
    expect(resolveActiveThread(fresh, 'social:gone', null)).toBeNull();
  });
});

describe('AC-01 runtime readiness', () => {
  const readiness = (state: 'ready' | 'degraded' | 'offline' | 'unknown', extra: Partial<NonNullable<SocialAgentPresence['readiness']>> = {}) => ({
    state, reason: `${state} because`, last_heartbeat_at: '2026-10-24T10:00:00Z', last_successful_reply_at: null,
    last_failed_attempt: null, runtime_failures_reported: false as const, ...extra,
  });

  it('shows heartbeat, last successful reply and last failed attempt separately, and never invents a runtime error', () => {
    const html = renderToStaticMarkup(createElement(ReadinessTable, { agents: [
      { ...agents[0], readiness: readiness('degraded', { last_failed_attempt: { at: '2026-10-24T09:00:00Z', message_id: 'm-1', observed: 'claim_lapsed_without_reply' } }) },
      { ...agents[1], readiness: readiness('ready', { last_successful_reply_at: '2026-10-24T09:30:00Z' }) },
    ] }));
    for (const text of ['degraded', 'ready', 'degraded because', 'claim lapsed without reply', 'failures not reported']) expect(html).toContain(text);
    expect(html).toContain('none recorded');
  });

  it('says unknown when the server sent no readiness instead of treating a heartbeat as ready', () => {
    const html = renderToStaticMarkup(createElement(ReadinessTable, { agents: [{ ...agents[0], present: true }] }));
    expect(html).toContain('unknown');
    expect(html).not.toContain('>ready<');
  });
});

const policy = (over: Partial<CommonsProposalPolicy> = {}): CommonsProposalPolicy => ({
  env: 'REFLECTION_PROPOSALS_MAX_PER_DAY', cap: 0, state: 'disabled', created_in_window: 0, remaining: 0, window: 'rolling_24h', window_hours: 24,
  scope: 'global', source: 'reflection', shared_producers: ['commons_social_learning', 'continuous_learning_loop', 'memory_candidate_review'],
  workers: [{ id: 'commons_proposal_review', env: 'COMMONS_PROPOSAL_REVIEW_ENABLED', enabled: false }, { id: 'grounding_agenda', env: 'COMMONS_AGENDA_GROUNDING', enabled: true }], ...over,
});

it('AC-10: shows the effective policy — cap 0 disables proposal generation, with scope, source, window, shared producers and workers', () => {
  const html = renderToStaticMarkup(createElement(ProposalPolicyBanner, { policy: policy() }));
  for (const text of ['Reflection recorded; proposal generation disabled by policy', 'REFLECTION_PROPOSALS_MAX_PER_DAY=0', 'scope global', 'source reflection',
    'rolling 24 h', 'continuous_learning_loop', 'memory_candidate_review', 'ordinary ideas cannot currently enter the proposal queue through this route',
    'Commons proposal review <strong>off</strong>', 'grounding agenda <strong>on</strong>']) expect(html).toContain(text);
  const exhausted = renderToStaticMarkup(createElement(ProposalPolicyBanner, { policy: policy({ cap: 5, state: 'exhausted', created_in_window: 5, remaining: 0 }) }));
  expect(exhausted).toContain('rate limit reached');
  expect(exhausted).toContain('5 created in the window');
  expect(exhausted).not.toContain('disabled by policy');
  expect(renderToStaticMarkup(createElement(ProposalPolicyBanner, { policy: policy({ cap: null, state: 'uncapped', remaining: null }) }))).toContain('REFLECTION_PROPOSALS_MAX_PER_DAY=unset');
});

it('AC-10: renders the recorded reason on the message, links a duplicate, and says unknown for a historical learning', () => {
  const base: CommonsProposalDisposition = { reason: 'policy_disabled', proposal_id: null, detail: null, cap: 0, created_in_window: 0, window: 'rolling_24h', scope: 'global', source: 'reflection', error_code: null, decided_at: '2026-10-24T19:00:00Z' };
  const render = (d: CommonsProposalDisposition) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Conversation, {
    thread: { ...thread('1', 'learned', ['a', 'b']), messages: [{ ...reply, improvement_id: null, improvement_status: null, proposal_disposition: d }] }, agents })));
  const disabled = render(base);
  expect(disabled).toContain('Reflection recorded; proposal generation disabled by policy');
  expect(disabled).toContain('scope global · source reflection · window rolling 24 h');
  expect(disabled).not.toContain('no registered improvement proposal yet');
  expect(render({ ...base, reason: 'rate_limited', cap: 3, created_in_window: 3 })).toContain('rate limit reached (3 of cap 3 in the rolling 24 h');
  const dup = render({ ...base, reason: 'duplicate', proposal_id: 'existing-7' });
  expect(dup).toContain('linked to existing proposal');
  expect(dup).toContain('existing-7');
  expect(render({ ...base, reason: 'duplicate', proposal_id: null })).toContain('not linked');
  expect(render({ ...base, reason: 'pending_grounding', proposal_id: 'p-9' })).toContain('parked until grounded');
  expect(render({ ...base, reason: 'runtime_failure', error_code: 'SQLITE_BUSY' })).toContain('failed at runtime (SQLITE_BUSY)');
  const unknown = render({ ...base, reason: 'unknown', cap: null, window: null, scope: null, source: null, decided_at: null });
  expect(unknown).toContain('Proposal reason unknown');
  expect(unknown).not.toContain('disabled by policy');
});
