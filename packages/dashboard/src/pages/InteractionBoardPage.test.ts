import { describe, expect, it } from 'vitest';
import type { AgentInteractionRecord } from '../lib/api';
import { buildInteractionRelations, buildInteractionThreads, filterInteractions } from './InteractionBoardPage';

const interactions: AgentInteractionRecord[] = [
  {
    id: 'message:1', timestamp: '2026-09-07T10:00:00.000Z', correlation_id: 'goal-1', causation_id: null,
    actor: { type: 'agent', id: 'maker', role: 'maker', runtime: 'codex', model: 'm1' }, action: 'message.review',
    target: { type: 'agent', id: 'checker' }, capability_id: null, decision: null, status: 'read', evidence_refs: ['evidence:1'],
    effect_scope: 'isolated', source: 'messages', summary: 'maker sent review to checker',
  },
  {
    id: 'event:1', timestamp: '2026-09-07T10:01:00.000Z', correlation_id: 'goal-1', causation_id: 'message:1',
    actor: { type: 'agent', id: 'checker', role: 'checker', runtime: 'opencode', model: 'm2' }, action: 'tool.invocation',
    target: { type: 'tool', id: 'test-runner' }, capability_id: 'tests', decision: 'allowed', status: 'recorded', evidence_refs: [],
    effect_scope: 'production', source: 'execution_events', summary: 'checker invoked test-runner',
  },
  {
    id: 'external:1', timestamp: '2026-09-07T09:00:00.000Z', correlation_id: null, causation_id: null,
    actor: { type: 'system', id: 'worldlab', role: null, runtime: null, model: null }, action: 'worldlab.finding',
    target: { type: 'finding', id: 'finding-1' }, capability_id: null, decision: null, status: 'observed', evidence_refs: [],
    effect_scope: 'simulated', source: 'external_events', summary: 'WorldLab emitted a finding',
  },
];

describe('interaction board models', () => {
  it('filters the shared ledger without hiding target-agent interactions', () => {
    expect(filterInteractions(interactions, { search: '', actor: 'checker', source: '', scope: '', status: '' })).toHaveLength(2);
    expect(filterInteractions(interactions, { search: 'evidence:1', actor: '', source: 'messages', scope: 'isolated', status: 'read' })).toEqual([interactions[0]]);
  });

  it('keeps correlation threads and unattributed evidence distinct', () => {
    expect(buildInteractionThreads(interactions)).toEqual([
      expect.objectContaining({ id: 'goal-1', count: 2, participants: ['checker', 'maker'] }),
      expect.objectContaining({ id: 'unattributed:external:1', count: 1 }),
    ]);
  });

  it('aggregates observed relations without merging different targets', () => {
    const relations = buildInteractionRelations([...interactions, { ...interactions[0], id: 'message:2' }]);
    expect(relations[0]).toMatchObject({ from: 'agent:maker', to: 'agent:checker', count: 2, actions: ['message.review'] });
    expect(relations).toHaveLength(3);
  });
});
