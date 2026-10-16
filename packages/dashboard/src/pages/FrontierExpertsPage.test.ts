import { describe, expect, it } from 'vitest';
import type { ExpertDedupeReport, ExpertSummary, ExpertSwarmRun } from '../lib/api';
import { dedupeLines, funnelCounts, groupDisagreements, NEXT_STATES, STATE_TONE, stateCounts, summarizeRun, tierLabel } from './FrontierExpertsPage';

const expert = (id: string, state: ExpertSummary['lifecycle_state']): ExpertSummary => ({ id, canonical_name: id, lifecycle_state: state, identity_confidence: 0.9, version: 1, updated_at: '', capabilities: [], provenance_json: '{}' });

describe('frontier experts page helpers (§36: tentative never shown as verified)', () => {
  it('marks only ACTIVE as verified and every other state as tentative, blocked or closed', () => {
    const verified = Object.entries(STATE_TONE).filter(([, tone]) => tone.tone === 'verified').map(([state]) => state);
    expect(verified).toEqual(['ACTIVE']);
    expect(STATE_TONE.DISCOVERED.label).toContain('signature');
    // Buttons never offer a jump into ACTIVE from a pre-governance state; the server guards the rest.
    expect(NEXT_STATES.DISCOVERED).toEqual(['REJECTED']);
    expect(NEXT_STATES.CAPABILITY_INFERRED).not.toContain('ACTIVE');
    expect(NEXT_STATES.APPROVED).toContain('ACTIVE');
    expect(tierLabel(1)).toBe('T1 primary');
    expect(tierLabel(4)).toBe('T4 signature');
  });

  it('counts states in lifecycle order and summarises runs with contradictions, attacks and abstentions visible', () => {
    expect(stateCounts([expert('a', 'ACTIVE'), expert('b', 'DISCOVERED'), expert('c', 'DISCOVERED')])).toEqual([{ state: 'DISCOVERED', count: 2 }, { state: 'ACTIVE', count: 1 }]);
    const run = { id: 'r', topic: 't', promotion_decision: 'CONTRADICTED', knowledge_updated: false, knowledge_candidate_id: null, duration_ms: 1, created_at: '', verdict: { score: 60, contradictions: ['x'], verification_status: 'contradicted' }, expert_answers: [],
      council: { abstained: false, reason: null, perspectives: [{ expert_id: 'e', canonical_name: 'E', why_selected: '', runtime: 'fake', output: { analysis: '', uncertainties: [], falsification: '' }, dropped_refs: [] }], claims: [], agreements: [], disagreements: [{ proposition: 'p', expert_a: 'e', expert_b: 'f', resolving_observation: 'o' }], uncertainties: [], adversarial: { attacks: [{ claim_id: 'c', attack: 'a', evidence_gap: 'g' }] }, rejected_perspectives: [{ expert_id: 'z', reason: 'PERSPECTIVE_OUTPUT_IMPERSONATES_EXPERT' }] } } as ExpertSwarmRun;
    expect(summarizeRun(run)).toEqual({ decision: 'CONTRADICTED', perspectives: 1, disagreements: 1, attacks: 1, rejected: 1, abstained: null });
    expect(summarizeRun({ ...run, council: { ...run.council!, abstained: true, reason: 'FRONTIER_EXPERTS_RUNTIME_NOT_CONFIGURED', perspectives: [] } }).abstained).toBe('FRONTIER_EXPERTS_RUNTIME_NOT_CONFIGURED');
    expect(summarizeRun({ ...run, council: undefined }).perspectives).toBe(0);
    expect(groupDisagreements([{ proposition: 'p', expert_a: 'a', expert_b: 'b', resolving_observation: 'o' }, { proposition: 'p', expert_a: 'c', expert_b: 'b', resolving_observation: 'o2' }, { proposition: 'q', expert_a: 'a', expert_b: 'd', resolving_observation: 'o3' }])).toEqual([{ proposition: 'p', pairs: 2, resolving_observation: 'o' }, { proposition: 'q', pairs: 1, resolving_observation: 'o3' }]);
  });

  it('funnel counts the whole registry per kind, not the capped list', () => {
    const funnel = [{ kind: 'person', state: 'ACTIVE' as const, count: 8 }, { kind: 'paper', state: 'CAPABILITY_INFERRED' as const, count: 900 }, { kind: 'person', state: 'CAPABILITY_INFERRED' as const, count: 311 }];
    expect(funnelCounts(funnel, '')).toEqual([{ state: 'CAPABILITY_INFERRED', count: 1211 }, { state: 'ACTIVE', count: 8 }]);
    expect(funnelCounts(funnel, 'paper')).toEqual([{ state: 'CAPABILITY_INFERRED', count: 900 }]);
  });

  it('FE-DEDUPE section shows counts only and keeps unknown metrics unknown (never 0)', () => {
    const report: ExpertDedupeReport = { at: '', writes: 0,
      totals: { units: 13, clusters: 8, duplicate_units: 5, inflation_factor: 1.625, duplicate_clusters: 4, distinct_titles: 8 },
      by_kind: [{ kind: 'paper', units: 10, clusters: 6, duplicate_units: 4, inflation_factor: 1.667 }], by_key_type: [],
      metrics_if_collapsed: { funnel: { units_before: 13, units_after: 8, cells_changed: 2 }, gap_demand: null, knowledge_fitness: null } };
    expect(dedupeLines(report)).toEqual(['13 units → 8 distinct works (5 duplicates in 4 clusters, ×1.625)', 'paper 10→6',
      'if collapsed: funnel 13→8 (2 cells change) · fitness inventory unknown · gap demand unknown']);
  });
});
