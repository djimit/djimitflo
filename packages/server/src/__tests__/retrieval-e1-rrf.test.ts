import { describe, expect, it } from 'vitest';
import { pairedBootstrapCI, rankE1Arm, reciprocalRankFusion, scoreE1, type E1Candidate, type E1Query } from '../services/retrieval-eval';
import { rankContextResults, type ContextResult } from '../services/context-injection-service';

const c = (id: string, source: string, score: number, trust_level = 'agent_generated'): E1Candidate => ({ id, source, score, trust_level });

describe('E1 RRF harness arm (docs/research/eco/E1-RRF_PROTOCOL.md)', () => {
  it('RRF scores are 1/(k+rank) within each source and sum across sources', () => {
    const fused = reciprocalRankFusion([c('a', 'okf_search', 7.5), c('b', 'okf_search', 3.1), c('x', 'qdrant_swarm', 0.92), c('a', 'qdrant_swarm', 0.4)]);
    expect(fused.get('a')).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(fused.get('b')).toBeCloseTo(1 / 62, 12);
    expect(fused.get('x')).toBeCloseTo(1 / 61, 12);
    expect(reciprocalRankFusion([c('a', 's', 1)], 0).get('a')).toBe(1);
  });

  it('RRF removes the score-scale effect that raw ranking has; min-max ties', () => {
    // best cosine hit vs a weak OKF hit on a larger scale
    const cands = [c('relevant-cosine', 'qdrant_swarm', 0.92), c('other-cosine', 'qdrant_swarm', 0.4), c('weak-okf', 'okf_search', 3.1), c('strong-okf', 'okf_search', 7.5)];
    expect(rankE1Arm(cands, 'raw')).toEqual(['strong-okf', 'weak-okf', 'relevant-cosine', 'other-cosine']);
    expect(rankE1Arm(cands, 'rrf').slice(0, 2).sort()).toEqual(['relevant-cosine', 'strong-okf']);
    expect(rankE1Arm(cands, 'rrf').slice(2).sort()).toEqual(['other-cosine', 'weak-okf']);
    expect(rankE1Arm(cands, 'minmax').slice(0, 2).sort()).toEqual(['relevant-cosine', 'strong-okf']);
  });

  it('trust tier comes first in every arm, identically', () => {
    const cands = [c('relevant', 'experience_retrieval', 0.95), c('irrelevant-approved', 'djimitkb_search', 0.05, 'approved'), c('validated', 'okf_search', 1, 'validated')];
    for (const arm of ['raw', 'minmax', 'rrf'] as const) expect(rankE1Arm(cands, arm)).toEqual(['irrelevant-approved', 'validated', 'relevant']);
    // an id listed twice keeps its best tier in rrf
    expect(rankE1Arm([c('a', 's1', 0.1), c('b', 's1', 0.9), c('a', 's2', 1, 'approved')], 'rrf')[0]).toBe('a');
  });

  it('raw and minmax arms are the unchanged prod ranking; the prod flag has no rrf value', () => {
    const cands = [c('p', 'qdrant_swarm', 0.2), c('q', 'okf_search', 5), c('r', 'qdrant_swarm', 0.9)];
    const prod = (env: NodeJS.ProcessEnv) => rankContextResults(cands.map((x) => ({ source: x.source as ContextResult['source'], concept_id: x.id, score: x.score, trust_level: x.trust_level, excerpt: '' })), env).map((x) => x.concept_id);
    expect(rankE1Arm(cands, 'raw')).toEqual(prod({}));
    expect(rankE1Arm(cands, 'minmax')).toEqual(prod({ RETRIEVAL_NORMALISE_SCORES: 'true' }));
    expect(prod({ RETRIEVAL_NORMALISE_SCORES: 'rrf' })).toEqual(prod({}));
  });

  it('paired bootstrap is deterministic and brackets the mean', () => {
    const d = Array.from({ length: 40 }, (_, i) => (i % 4) / 10);
    const ci = pairedBootstrapCI(d);
    expect(pairedBootstrapCI(d)).toEqual(ci);
    expect(ci.lo).toBeLessThanOrEqual(ci.mean); expect(ci.hi).toBeGreaterThanOrEqual(ci.mean); expect(ci.lo).toBeGreaterThan(0);
    expect(pairedBootstrapCI(Array(30).fill(0))).toEqual({ mean: 0, lo: 0, hi: 0 });
  });

  it('fewer than 30 eligible queries is INSUFFICIENT with null metrics (never 0); single-source queries are excluded', () => {
    const q = (i: number, two = true): E1Query => ({ id: `q${i}`, relevant: ['rel'], candidates: [c('rel', 'qdrant_swarm', 0.9), ...(two ? [c('noise', 'okf_search', 5)] : [c('noise', 'qdrant_swarm', 0.1)])] });
    const r = scoreE1([...Array.from({ length: 29 }, (_, i) => q(i)), q(99, false)]);
    expect(r).toEqual({ n_eligible: 29, n_excluded: 1, verdict: 'INSUFFICIENT', primary: null, arms: null, secondary: null });
  });

  it('30 queries where RRF lifts the relevant cosine hit over a larger-scale source: SUPPORTED; identical arms: FALSIFIED', () => {
    const lift = Array.from({ length: 30 }, (_, i): E1Query => ({ id: `q${i}`, relevant: ['rel'], candidates: [c('rel', 'qdrant_swarm', 0.9), c('n1', 'okf_search', 5), c('n2', 'okf_search', 4), c('n3', 'qdrant_swarm', 0.1)] }));
    const s = scoreE1(lift);
    expect(s.verdict).toBe('SUPPORTED');
    expect(s.arms).toEqual({ raw: { mrr: 0.3333, recall5: 1 }, minmax: { mrr: 1, recall5: 1 }, rrf: { mrr: 1, recall5: 1 } });
    const same = lift.map((q) => ({ ...q, candidates: [c('rel', 'qdrant_swarm', 0.9), c('n1', 'okf_search', 0.1)] }));
    expect(scoreE1(same).verdict).toBe('FALSIFIED');
    expect(scoreE1(same).primary).toEqual({ mrr_rrf_minus_raw: { mean: 0, lo: 0, hi: 0 } });
  });
});
