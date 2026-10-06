import fs from 'fs';
import path from 'path';
import { expect, it } from 'vitest';
import { cosineRetriever, evaluateRetrieval } from '../services/retrieval-eval';
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
