import { expect, it } from 'vitest';
import { evolveWinner, rankEvolveCandidates, type EvolveCandidate } from '../services/evolve-fitness-service';

const c = (id: string, over: Partial<EvolveCandidate> = {}): EvolveCandidate => ({
  makerLeaseId: id, species: id, exitZero: true, checksPassed: true, withinBudget: true,
  mutationScore: 60, diffLines: 80, tokens: 1000, finishedAt: '2026-09-24T02:00:00Z', ...over,
});

it('hard gates first, then mutation score, diff size, tokens, finish time', () => {
  const ranked = rankEvolveCandidates([
    c('fails-checks', { checksPassed: false, mutationScore: 99 }),
    c('lower-score', { mutationScore: 55 }),
    c('best', { mutationScore: 70, diffLines: 120 }),
    c('same-score-smaller', { mutationScore: 55, diffLines: 40 }),
  ]);
  expect(ranked.map((r) => r.makerLeaseId)).toEqual(['best', 'same-score-smaller', 'lower-score', 'fails-checks']);
  expect(ranked[0].reason).toBe('winner');
  expect(ranked[3]).toMatchObject({ eligible: false, reason: 'deterministic checks failed' });
  expect(evolveWinner(ranked)?.makerLeaseId).toBe('best');
});

it('unmeasured mutation score ranks below measured; ties break on tokens then finish time', () => {
  expect(rankEvolveCandidates([c('unmeasured', { mutationScore: null }), c('measured', { mutationScore: 10 })])[0].makerLeaseId).toBe('measured');
  expect(rankEvolveCandidates([c('late', { finishedAt: '2026-09-24T03:00:00Z' }), c('early')])[0].makerLeaseId).toBe('early');
  expect(rankEvolveCandidates([c('costly', { tokens: 9000 }), c('cheap', { tokens: 100 })])[0].makerLeaseId).toBe('cheap');
});

it('no winner when nobody passes the hard gates', () => {
  expect(evolveWinner(rankEvolveCandidates([c('a', { exitZero: false }), c('b', { withinBudget: false })]))).toBeNull();
});
