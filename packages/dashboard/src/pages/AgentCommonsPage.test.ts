import { describe, expect, it } from 'vitest';
import type { SocialAgentPresence, SocialThread } from '../lib/api';
import { agentHue, layoutConstellation, luredAgents } from './AgentCommonsPage';

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
