import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SocialMessage, SocialAgentPresence, SocialThread } from '../lib/api';
import { agentHue, Conversation, layoutConstellation, luredAgents, runtimeParticipation } from './AgentCommonsPage';

const agents: SocialAgentPresence[] = [
  { id: 'a', name: 'A', status: 'active', capabilities: [], model: 'm', runtime: 'codex', last_heartbeat_at: null, present: true },
  { id: 'b', name: 'B', status: 'active', capabilities: [], model: 'm', runtime: null, last_heartbeat_at: null, present: false },
];
const thread = (id: string, stage: SocialThread['stage'], participants: string[]): SocialThread => ({
  id, topic: 't', topic_ref: null, participants, stage, started_at: '2026-09-13T10:00:00Z', last_activity_at: '2026-09-13T10:00:00Z', learnings: 0, messages: [],
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
  for (const text of ['Onderwerp aangedragen door een agent', 'Explore retrieval', 'Djimitflo', 'proposal-1', 'proposed', 'reflectie-kandidaat', 'run-1']) expect(html).toContain(text);
  expect(html).not.toContain('Geleerd');
  expect(html).toContain('href="/compliance#improvement-inbox-title"');
  expect(html).toContain('Open review-inbox');
  const suggestion = renderToStaticMarkup(createElement(Conversation, { thread: { ...discussion, messages: [{ ...reply, improvement_id: null }] }, agents }));
  expect(suggestion).toContain('nog geen geregistreerd verbeteringsvoorstel');
  expect(suggestion).not.toContain('Open review-inbox');
  const approved = renderToStaticMarkup(createElement(Conversation, { thread: { ...discussion, messages: [{ ...reply, improvement_status: 'approved' }] }, agents }));
  expect(approved).not.toContain('Open review-inbox');
});
