import { describe, it, expect } from 'vitest';
import type { LureStatus, SocialAgentPresence, SocialMessage, SocialThread } from '../../lib/api';
import {
  STAGE, LURE_COLOR, agentHue, luredAgents, layoutConstellation,
  runtimeParticipation, resolveActiveThread, PAGE_SIZE, RECORD_COLOR,
} from './model';

const msg = (over: Partial<SocialMessage> = {}): SocialMessage => ({
  id: 'm1', from: 'a', to: 'b', action: 'social.response', timestamp: '2026-01-01T00:00:00Z',
  status: 'delivered', reply_to: null, text: '', evidence: [], answer: null, uncertainty: null,
  falsifiable_next_step: null, creative_alternative: null, stop_condition: null,
  runtime: 'opencode', model_id: 'gpt', reflection_id: null, reflection_status: null, ...over,
});
const thread = (over: Partial<SocialThread> = {}): SocialThread => ({
  id: 't1', topic: 't', topic_ref: null, participants: ['a', 'b'], stage: 'asked',
  started_at: '', last_activity_at: '', learnings: 0, messages: [], ...over,
});
const agent = (over: Partial<SocialAgentPresence> = {}): SocialAgentPresence => ({
  id: 'a', name: 'A', status: 'active', capabilities: [], model: 'm', runtime: 'opencode',
  last_heartbeat_at: null, present: true, activity: [], ...over,
});

describe('STAGE / LURE_COLOR / constants', () => {
  it('exposes the three stages with label, color and icon, plus lure and record colors and page size', () => {
    expect(Object.keys(STAGE).sort()).toEqual(['asked', 'learned', 'responding']);
    expect(STAGE.asked).toMatchObject({ label: 'Curious', color: 'rgb(80 200 255)' });
    expect(STAGE.responding).toMatchObject({ label: 'In conversation', color: 'rgb(250 204 21)' });
    expect(STAGE.learned).toMatchObject({ label: 'Reflection', color: 'rgb(34 197 94)' });
    expect(typeof STAGE.asked.icon).toBe('object');
    expect(LURE_COLOR).toBe('rgb(217 70 239)');
    expect(RECORD_COLOR).toBe('rgb(148 163 184)');
    expect(PAGE_SIZE).toBe(20);
  });
});

describe('agentHue', () => {
  it('is deterministic, in 0..359, and 0 for the empty string', () => {
    expect(agentHue('a')).toBe(agentHue('a'));
    expect(agentHue('a')).toBeGreaterThanOrEqual(0);
    expect(agentHue('a')).toBeLessThan(360);
    expect(agentHue('ab')).not.toBe(agentHue('a'));
    expect(agentHue('')).toBe(0);
  });
});

describe('luredAgents', () => {
  it('returns an empty map for null lures', () => {
    expect(luredAgents(null).size).toBe(0);
  });
  it('collects invited/seen invitees, skips bit/expired, dedupes by agent_id', () => {
    const lures: LureStatus = {
      lures: [{
        id: 'l1', topic: 't', topic_ref: null, created_by: 'x', created_at: '', expires_at: '', bites: 0,
        invitees: [
          { agent_id: 'a', name: 'A', state: 'invited', bit_at: null },
          { agent_id: 'b', name: 'B', state: 'seen', bit_at: null },
          { agent_id: 'a', name: 'A2', state: 'seen', bit_at: null },
          { agent_id: 'c', name: 'C', state: 'bit', bit_at: '2026-01-01T00:00:00Z' },
          { agent_id: 'd', name: 'D', state: 'expired', bit_at: null },
        ],
      }], probes: [], probe_count: 0,
    };
    expect([...luredAgents(lures).entries()].sort()).toEqual([['a', 'A'], ['b', 'B']]);
  });
});

describe('layoutConstellation', () => {
  it('places a single agent at the centre with no edges', () => {
    const { nodes, edges } = layoutConstellation([agent()], [], 320);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ x: 160, y: 160, present: true, lured: false, hue: agentHue('a') });
    expect(edges).toEqual([]);
  });
  it('merges agent, thread participant and lured ids (sorted), counts threads, marks lured hollow', () => {
    const { nodes } = layoutConstellation(
      [agent({ id: 'a', name: 'A' })],
      [thread({ id: 't1', participants: ['a', 'b'] }), thread({ id: 't2', participants: ['b', 'c'] })],
      320, new Map([['z', 'Z']]),
    );
    expect(nodes.map((n) => n.id)).toEqual(['a', 'b', 'c', 'z']);
    expect(nodes.find((n) => n.id === 'a')!.threads).toBe(1);
    expect(nodes.find((n) => n.id === 'b')!.threads).toBe(2);
    expect(nodes.find((n) => n.id === 'b')).toMatchObject({ present: false, lured: false, name: 'b' });
    expect(nodes.find((n) => n.id === 'z')).toMatchObject({ present: false, lured: true, name: 'Z' });
  });
  it('builds one edge per pair with shared count and the furthest stage reached', () => {
    const edgesAsc = layoutConstellation(
      [agent({ id: 'a' }), agent({ id: 'b' })],
      [thread({ id: 't1', participants: ['a', 'b'], stage: 'asked' }),
       thread({ id: 't2', participants: ['a', 'b'], stage: 'learned' })], 320,
    ).edges;
    expect(edgesAsc).toHaveLength(1);
    expect(edgesAsc[0]).toMatchObject({ count: 2, stage: 'learned' });
    const edgesDesc = layoutConstellation(
      [agent({ id: 'a' }), agent({ id: 'b' })],
      [thread({ id: 't1', participants: ['a', 'b'], stage: 'learned' }),
       thread({ id: 't2', participants: ['a', 'b'], stage: 'asked' })], 320,
    ).edges;
    expect(edgesDesc[0].stage).toBe('learned');
  });
  it('creates nodes from thread participants even with no agents present', () => {
    const { nodes, edges } = layoutConstellation([], [thread({ participants: ['x', 'y'] })], 320);
    expect(nodes.map((n) => n.id)).toEqual(['x', 'y']);
    expect(nodes.every((n) => n.present === false && n.lured === false)).toBe(true);
    expect(edges).toHaveLength(1);
  });
});

describe('runtimeParticipation', () => {
  it('skips social.question and runtime-less messages, groups by agent/runtime/model', () => {
    const rows = runtimeParticipation([thread({
      participants: ['a', 'b'], messages: [
        msg({ id: 'q', from: 'a', action: 'social.question', timestamp: '2026-01-01T00:00:00Z' }),
        msg({ id: 'r1', from: 'b', timestamp: '2026-01-02T00:00:00Z' }),
        msg({ id: 'r2', from: 'b', runtime: null, model_id: null, timestamp: '2026-01-03T00:00:00Z' }),
        msg({ id: 'r3', from: 'b', timestamp: '2026-01-01T00:00:00Z' }),
        msg({ id: 'r4', from: 'b', model_id: 'claude', timestamp: '2026-01-05T00:00:00Z' }),
      ],
    })]);
    expect(rows).toHaveLength(2);
    const gpt = rows.find((r) => r.model === 'gpt')!;
    expect(gpt).toMatchObject({ agent: 'b', runtime: 'opencode', replies: 2, lastReply: '2026-01-02T00:00:00Z' });
    expect(rows.find((r) => r.model === 'claude')!).toMatchObject({ replies: 1, lastReply: '2026-01-05T00:00:00Z' });
  });
  it('falls back to "model unknown" and keeps the latest lastReply', () => {
    const rows = runtimeParticipation([thread({
      participants: ['a', 'b'], messages: [
        msg({ id: 'r1', from: 'b', model_id: null, timestamp: '2026-03-01T00:00:00Z' }),
        msg({ id: 'r2', from: 'b', model_id: null, timestamp: '2026-02-01T00:00:00Z' }),
      ],
    })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe('model unknown');
    expect(rows[0]).toMatchObject({ replies: 2, lastReply: '2026-03-01T00:00:00Z' });
  });
});

describe('resolveActiveThread', () => {
  const t1 = thread({ id: 't1' });
  const t2 = thread({ id: 't2' });
  it('returns the newest thread when nothing is selected, null when empty', () => {
    expect(resolveActiveThread([t1, t2], null, null)).toBe(t1);
    expect(resolveActiveThread([], null, null)).toBeNull();
  });
  it('returns the selected thread, the previous copy when it dropped off, else null', () => {
    expect(resolveActiveThread([t1, t2], 't2', null)).toBe(t2);
    expect(resolveActiveThread([t1], 't2', t2)).toBe(t2);
    expect(resolveActiveThread([t1], 't2', t1)).toBeNull();
  });
});
