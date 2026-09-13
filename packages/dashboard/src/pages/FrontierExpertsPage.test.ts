import { describe, expect, it } from 'vitest';
import type { ExpertSummary, ExpertSwarmRun } from '../lib/api';
import { NEXT_STATES, STATE_TONE, stateCounts, summarizeRun, tierLabel } from './FrontierExpertsPage';

const expert = (id: string, state: ExpertSummary['lifecycle_state']): ExpertSummary => ({ id, canonical_name: id, lifecycle_state: state, identity_confidence: 0.9, version: 1, updated_at: '', capabilities: [], provenance_json: '{}' });

describe('frontier experts page helpers (§36: tentative never shown as verified)', () => {
  it('marks only ACTIVE as verified and every other state as tentative, blocked or closed', () => {
    const verified = Object.entries(STATE_TONE).filter(([, tone]) => tone.tone === 'verified').map(([state]) => state);
    expect(verified).toEqual(['ACTIVE']);
    expect(STATE_TONE.DISCOVERED.label).toContain('handtekening');
    // Buttons never offer a jump into ACTIVE from a pre-governance state; the server guards the rest.
    expect(NEXT_STATES.DISCOVERED).toEqual(['REJECTED']);
    expect(NEXT_STATES.CAPABILITY_INFERRED).not.toContain('ACTIVE');
    expect(NEXT_STATES.APPROVED).toContain('ACTIVE');
    expect(tierLabel(1)).toBe('T1 primair');
    expect(tierLabel(4)).toBe('T4 handtekening');
  });

  it('counts states in lifecycle order and summarises runs with contradictions, attacks and abstentions visible', () => {
    expect(stateCounts([expert('a', 'ACTIVE'), expert('b', 'DISCOVERED'), expert('c', 'DISCOVERED')])).toEqual([{ state: 'DISCOVERED', count: 2 }, { state: 'ACTIVE', count: 1 }]);
    const run = { id: 'r', topic: 't', promotion_decision: 'CONTRADICTED', knowledge_updated: false, knowledge_candidate_id: null, duration_ms: 1, created_at: '', verdict: { score: 60, contradictions: ['x'], verification_status: 'contradicted' }, expert_answers: [],
      council: { abstained: false, reason: null, perspectives: [{ expert_id: 'e', canonical_name: 'E', why_selected: '', runtime: 'fake', output: { analysis: '', uncertainties: [], falsification: '' }, dropped_refs: [] }], claims: [], agreements: [], disagreements: [{ proposition: 'p', expert_a: 'e', expert_b: 'f', resolving_observation: 'o' }], uncertainties: [], adversarial: { attacks: [{ claim_id: 'c', attack: 'a', evidence_gap: 'g' }] }, rejected_perspectives: [{ expert_id: 'z', reason: 'PERSPECTIVE_OUTPUT_IMPERSONATES_EXPERT' }] } } as ExpertSwarmRun;
    expect(summarizeRun(run)).toEqual({ decision: 'CONTRADICTED', perspectives: 1, disagreements: 1, attacks: 1, rejected: 1, abstained: null });
    expect(summarizeRun({ ...run, council: { ...run.council!, abstained: true, reason: 'FRONTIER_EXPERTS_RUNTIME_NOT_CONFIGURED', perspectives: [] } }).abstained).toBe('FRONTIER_EXPERTS_RUNTIME_NOT_CONFIGURED');
    expect(summarizeRun({ ...run, council: undefined }).perspectives).toBe(0);
  });
});
