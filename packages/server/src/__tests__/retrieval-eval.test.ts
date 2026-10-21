import fs from 'fs';
import path from 'path';
import { expect, it } from 'vitest';
import { cosineRetriever, evaluateRetrieval, pairedBootstrapCI, rankE1Arm, reciprocalRankFusion, scoreE1, E1_MIN_QUERIES, type E1Candidate, type E1Query, type LabelledQuery } from '../services/retrieval-eval';
import { rankContextResults, type ContextResult } from '../services/context-injection-service';

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../../corpus/retrieval/fixture.json'), 'utf8'));

it('UX-24: recall@k and MRR per source on the labelled offline fixture are deterministic', () => {
  const m = evaluateRetrieval(fixture.queries, cosineRetriever(fixture.corpus));
  expect(m).toEqual([
    { source: 'experience', n: 2, recall: { 1: 1, 3: 1, 5: 1, 10: 1 }, mrr: 1 },
    // q-auth's relevant page ranks 3rd (two gym pages are closer): recall@1 0.5, MRR 0.7778
    { source: 'kb', n: 3, recall: { 1: 0.5, 3: 1, 5: 1, 10: 1 }, mrr: 0.7778 },
  ]);
  expect(evaluateRetrieval([{ id: 'q', source: 's', relevant: ['x'] }], () => [])).toEqual([{ source: 's', n: 1, recall: { 1: 0, 3: 0, 5: 0, 10: 0 }, mrr: 0 }]);
});

const r = (source: ContextResult['source'], title: string, score: number, trust_level = 'agent_generated'): ContextResult => ({ source, title, score, trust_level, excerpt: title });

it('UX-24: today the injected-context ranking compares raw scores across sources and puts trust tier above relevance', () => {
  // same tier: a weak OKF hit on a large score scale outranks the best Qdrant cosine hit
  const sameTier = [r('qdrant_swarm', 'relevant cosine', 0.92), r('okf_search', 'weak okf', 3.1), r('okf_search', 'strong okf', 7.5)];
  expect(rankContextResults([...sameTier], {}).map((x) => x.title)).toEqual(['strong okf', 'weak okf', 'relevant cosine']);
  // tier first: an approved but irrelevant item outranks a highly relevant agent-generated one
  const tiers = [r('experience_retrieval', 'relevant', 0.95), r('djimitkb_search', 'irrelevant approved', 0.05, 'approved')];
  expect(rankContextResults([...tiers], {}).map((x) => x.title)).toEqual(['irrelevant approved', 'relevant']);
});

it('UX-24: RETRIEVAL_NORMALISE_SCORES normalises within each source; off leaves the order byte-identical', () => {
  const sameTier = [r('qdrant_swarm', 'relevant cosine', 0.92), r('qdrant_swarm', 'other cosine', 0.4), r('okf_search', 'weak okf', 3.1), r('okf_search', 'strong okf', 7.5)];
  expect(rankContextResults([...sameTier], { RETRIEVAL_NORMALISE_SCORES: 'true' }).map((x) => x.title).slice(0, 2).sort()).toEqual(['relevant cosine', 'strong okf']);
  expect(rankContextResults([...sameTier], { RETRIEVAL_NORMALISE_SCORES: 'true' }).map((x) => x.title).slice(2).sort()).toEqual(['other cosine', 'weak okf']);
  expect(rankContextResults([...sameTier], {}).map((x) => x.title)).toEqual(['strong okf', 'weak okf', 'relevant cosine', 'other cosine']);
});

// ---- evaluateRetrieval: grouping, sorting, empty-relevant and MRR-miss edge cases ----

it('evaluateRetrieval groups by source, sorts sources ascending and averages recall/MRR across queries', () => {
  const queries: LabelledQuery[] = [
    { id: 'z', source: 'zeta', relevant: ['a', 'b'] },
    { id: 'z2', source: 'zeta', relevant: ['a'] },
    { id: 'a', source: 'alpha', relevant: ['m'] },
  ];
  // retriever returns a fixed ranked list per query
  const retrieve = (q: LabelledQuery) => (q.id === 'z' ? ['a', 'b'] : q.id === 'z2' ? ['c', 'a'] : ['m']);
  const m = evaluateRetrieval(queries, retrieve);
  // sources sorted ascending: alpha before zeta
  expect(m.map((x) => x.source)).toEqual(['alpha', 'zeta']);
  // alpha: 1 query, rel m found at rank1 -> recall all k = 1, mrr 1
  expect(m[0]).toEqual({ source: 'alpha', n: 1, recall: { 1: 1, 3: 1, 5: 1, 10: 1 }, mrr: 1 });
  // zeta q1: rel {a,b}, ranked [a,b] -> recall@1 = 1/2, @3=1, mrr 1 (a at rank1)
  // zeta q2: rel {a}, ranked [c,a] -> recall@1 = 0, @3=1, mrr 1/2 (a at rank2)
  // averaged: recall@1 = (0.5+0)/2 = 0.25, @3 = 1, mrr = (1+0.5)/2 = 0.75
  expect(m[1]).toEqual({ source: 'zeta', n: 2, recall: { 1: 0.25, 3: 1, 5: 1, 10: 1 }, mrr: 0.75 });
});

it('evaluateRetrieval treats empty relevant sets as zero recall and zero MRR (UNKNOWN is not PASS)', () => {
  const m = evaluateRetrieval(
    [{ id: 'q', source: 's', relevant: [] }],
    () => ['x', 'y'],
  );
  expect(m).toEqual([{ source: 's', n: 1, recall: { 1: 0, 3: 0, 5: 0, 10: 0 }, mrr: 0 }]);
});

it('evaluateRetrieval reports MRR 0 when no relevant id is retrieved', () => {
  const m = evaluateRetrieval(
    [{ id: 'q', source: 's', relevant: ['rel'] }],
    () => ['nope1', 'nope2'],
  );
  expect(m[0].mrr).toBe(0);
  expect(m[0].recall).toEqual({ 1: 0, 3: 0, 5: 0, 10: 0 });
});

// ---- cosineRetriever: source filter, tie-break, zero-norm, ranking ----

it('cosineRetriever only ranks corpus items of the query source, by descending cosine', () => {
  const corpus = [
    { id: 'kb-a', source: 'kb', embedding: [1, 0] },
    { id: 'kb-b', source: 'kb', embedding: [0, 1] },
    { id: 'exp-a', source: 'experience', embedding: [1, 0] },
  ];
  const retrieve = cosineRetriever(corpus);
  // query embedding aligned with kb-a; exp-a must never appear
  expect(retrieve({ id: 'q', source: 'kb', embedding: [1, 0], relevant: [] })).toEqual(['kb-a', 'kb-b']);
  expect(retrieve({ id: 'q', source: 'experience', embedding: [1, 0], relevant: [] })).toEqual(['exp-a']);
});

it('cosineRetriever breaks cosine ties by ascending id', () => {
  const corpus = [
    { id: 'b', source: 's', embedding: [1, 0] },
    { id: 'a', source: 's', embedding: [1, 0] },
  ];
  expect(cosineRetriever(corpus)({ id: 'q', source: 's', embedding: [1, 0], relevant: [] })).toEqual(['a', 'b']);
});

it('cosineRetriever does not divide by zero for a zero-magnitude embedding (norm falls back to 1)', () => {
  const corpus = [{ id: 'z', source: 's', embedding: [0, 0] }];
  const out = cosineRetriever(corpus)({ id: 'q', source: 's', embedding: [0, 0], relevant: [] });
  expect(out).toEqual(['z']);
});

// ---- reciprocalRankFusion ----

const cand = (id: string, source: string, score: number, trust_level?: string): E1Candidate => ({ id, source, score, trust_level });

it('reciprocalRankFusion fuses 1/(k+rank) per source, rank 1-based by descending score', () => {
  const fused = reciprocalRankFusion([
    cand('a1', 'A', 2), cand('a2', 'A', 1),
    cand('b1', 'B', 5), cand('b2', 'B', 3),
  ], 60);
  expect(fused.get('a1')).toBeCloseTo(1 / 61, 10);
  expect(fused.get('a2')).toBeCloseTo(1 / 62, 10);
  expect(fused.get('b1')).toBeCloseTo(1 / 61, 10);
  expect(fused.get('b2')).toBeCloseTo(1 / 62, 10);
});

it('reciprocalRankFusion respects the k parameter', () => {
  const fused = reciprocalRankFusion([cand('a1', 'A', 2), cand('a2', 'A', 1)], 1);
  expect(fused.get('a1')).toBeCloseTo(1 / 2, 10);
  expect(fused.get('a2')).toBeCloseTo(1 / 3, 10);
});

it('reciprocalRankFusion breaks score ties by ascending id within a source', () => {
  const fused = reciprocalRankFusion([cand('b', 'A', 1), cand('a', 'A', 1)], 60);
  expect(fused.get('a')).toBeCloseTo(1 / 61, 10);
  expect(fused.get('b')).toBeCloseTo(1 / 62, 10);
});

it('reciprocalRankFusion sums contributions when an id appears in multiple sources', () => {
  const fused = reciprocalRankFusion([cand('x', 'A', 1), cand('x', 'B', 1)], 60);
  expect(fused.get('x')).toBeCloseTo(2 / 61, 10);
});

it('reciprocalRankFusion returns an empty map for no candidates', () => {
  expect(reciprocalRankFusion([]).size).toBe(0);
});

// ---- rankE1Arm ----

it('rankE1Arm rrf orders trust tier above fused score', () => {
  // approved item has lower fused score than agent_generated, but tier wins
  const ranked = rankE1Arm([
    cand('low', 'A', 1, 'approved'),
    cand('high', 'B', 5, 'agent_generated'),
  ], 'rrf');
  expect(ranked).toEqual(['low', 'high']);
});

it('rankE1Arm rrf takes the best (minimum) tier when an id repeats across sources', () => {
  const ranked = rankE1Arm([
    cand('x', 'A', 1, 'agent_generated'),
    cand('x', 'B', 1, 'approved'),
    cand('y', 'A', 9, 'agent_generated'),
  ], 'rrf');
  // x has approved tier (0) so comes before y (agent_generated, 2)
  expect(ranked[0]).toBe('x');
  expect(ranked).toContain('y');
});

it('rankE1Arm raw dedups ids keeping the first (best-placed) occurrence', () => {
  // raw sorts by tier(2) then score desc: dup(B,0.95), dup(A,0.9), uniq(0.8)
  const ranked = rankE1Arm([
    cand('dup', 'A', 0.9), cand('uniq', 'A', 0.8), cand('dup', 'B', 0.95),
  ], 'raw');
  expect(ranked).toEqual(['dup', 'uniq']);
});

it('rankE1Arm minmax normalises scores within each source before ranking', () => {
  // qdrant scores 0.5..0.9 -> rel norm 0, noise norm 1; okf scores 0.1..0.5 -> rel norm 1, noise 0
  const ranked = rankE1Arm([
    cand('rel', 'qdrant_swarm', 0.5), cand('noiseA', 'qdrant_swarm', 0.9),
    cand('rel', 'okf_search', 0.5), cand('noiseB', 'okf_search', 0.1),
  ], 'minmax');
  // normalised: noiseA=1, rel(okf)=1, rel(qdrant)=0, noiseB=0; tier-equal sort desc keeps input order on ties;
  // dedup rel -> first (okf) occurrence: [noiseA, rel, noiseB]
  expect(ranked).toEqual(['noiseA', 'rel', 'noiseB']);
});

// ---- pairedBootstrapCI ----

it('pairedBootstrapCI is deterministic for a fixed seed and reports the true mean', () => {
  const diffs = [0.5, -0.3, 0.2, 0.1, -0.4];
  const a = pairedBootstrapCI(diffs);
  const b = pairedBootstrapCI(diffs);
  expect(a).toEqual(b);
  const mean = diffs.reduce((s, x) => s + x, 0) / diffs.length;
  expect(a.mean).toBeCloseTo(Math.round(mean * 1e4) / 1e4, 10);
  expect(a.lo).toBeLessThanOrEqual(a.mean);
  expect(a.hi).toBeGreaterThanOrEqual(a.mean);
});

it('pairedBootstrapCI collapses to a point CI (lo=hi=mean) for constant diffs', () => {
  const { mean, lo, hi } = pairedBootstrapCI([0.5, 0.5, 0.5, 0.5]);
  expect(mean).toBe(0.5);
  expect(lo).toBe(0.5);
  expect(hi).toBe(0.5);
});

it('pairedBootstrapCI mean is zero for symmetric +/- diffs', () => {
  expect(pairedBootstrapCI([1, -1, 1, -1]).mean).toBe(0);
});

// ---- scoreE1: eligibility, INSUFFICIENT, SUPPORTED, FALSIFIED ----

const supportedQuery = (i: number): E1Query => ({
  id: `q-sup-${i}`,
  relevant: ['rel'],
  candidates: [
    cand('rel', 'qdrant_swarm', 0.5), cand('noiseA', 'qdrant_swarm', 0.9),
    cand('rel', 'okf_search', 0.5), cand('noiseB', 'okf_search', 0.1),
  ],
});
// raw MRR 0.5 (rel at rank2), rrf MRR 1 (rel fused top) -> diff 0.5 every query

const falsifiedQuery = (i: number): E1Query => ({
  id: `q-fal-${i}`,
  relevant: ['rel'],
  candidates: [
    cand('rel', 'qdrant_swarm', 0.9), cand('noiseA', 'qdrant_swarm', 0.1),
    cand('noiseB', 'okf_search', 0.1),
  ],
});
// raw MRR 1, rrf MRR 1 -> diff 0

const ineligibleNoRelevant: E1Query = { id: 'q-no-rel', relevant: [], candidates: [cand('a', 'A', 1), cand('b', 'B', 1)] };
const ineligibleOneSource: E1Query = { id: 'q-one-src', relevant: ['a'], candidates: [cand('a', 'A', 1), cand('b', 'A', 2)] };

it('scoreE1 returns INSUFFICIENT with null metrics below the minimum eligible threshold', () => {
  const eligible = Array.from({ length: E1_MIN_QUERIES - 1 }, (_, i) => supportedQuery(i));
  const report = scoreE1([...eligible, ineligibleNoRelevant, ineligibleOneSource]);
  expect(report.verdict).toBe('INSUFFICIENT');
  expect(report.n_eligible).toBe(E1_MIN_QUERIES - 1);
  expect(report.n_excluded).toBe(2);
  expect(report.primary).toBeNull();
  expect(report.arms).toBeNull();
  expect(report.secondary).toBeNull();
});

it('scoreE1 excludes queries with no relevant ids or a single candidate source', () => {
  const eligible = Array.from({ length: E1_MIN_QUERIES }, (_, i) => supportedQuery(i));
  const report = scoreE1([...eligible, ineligibleNoRelevant, ineligibleOneSource]);
  expect(report.n_eligible).toBe(E1_MIN_QUERIES);
  expect(report.n_excluded).toBe(2);
  expect(report.verdict).not.toBe('INSUFFICIENT');
});

it('scoreE1 returns SUPPORTED with primary CI bounded above zero when rrf beats raw on every query', () => {
  const report = scoreE1(Array.from({ length: E1_MIN_QUERIES }, (_, i) => supportedQuery(i)));
  expect(report.verdict).toBe('SUPPORTED');
  expect(report.primary).not.toBeNull();
  expect(report.primary!.mrr_rrf_minus_raw.lo).toBeGreaterThan(0);
  expect(report.primary!.mrr_rrf_minus_raw).toEqual({ mean: 0.5, lo: 0.5, hi: 0.5 });
  // arms: raw 0.5, minmax 0.5, rrf 1; recall5 = 1 for every arm
  expect(report.arms).toEqual({
    raw: { mrr: 0.5, recall5: 1 },
    minmax: { mrr: 0.5, recall5: 1 },
    rrf: { mrr: 1, recall5: 1 },
  });
  expect(report.secondary).not.toBeNull();
  expect(report.secondary!.mrr_rrf_minus_minmax).toEqual({ mean: 0.5, lo: 0.5, hi: 0.5 });
  expect(report.secondary!.recall5_rrf_minus_raw).toEqual({ mean: 0, lo: 0, hi: 0 });
});

it('scoreE1 returns FALSIFIED when rrf does not beat raw (CI lower bound not above zero)', () => {
  const report = scoreE1(Array.from({ length: E1_MIN_QUERIES }, (_, i) => falsifiedQuery(i)));
  expect(report.verdict).toBe('FALSIFIED');
  expect(report.primary).not.toBeNull();
  expect(report.primary!.mrr_rrf_minus_raw.lo).toBe(0);
  expect(report.arms).toEqual({
    raw: { mrr: 1, recall5: 1 },
    minmax: { mrr: 1, recall5: 1 },
    rrf: { mrr: 1, recall5: 1 },
  });
});