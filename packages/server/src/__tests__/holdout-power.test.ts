import { expect, it } from 'vitest';
import { designEffect, discordantRates, mcnemarExactPower, pairedPowerReport, signFlipPValue } from '../services/holdout-power';
import { mcnemarOneSided } from '../services/dream-evolution';

// Reported, never used to size a holdout: what a paired holdout of n tasks can show.
it('discordant-pair rates under independence and under within-task correlation', () => {
  const r = discordantRates(0.37, 0.57);
  expect(r.p10).toBeCloseTo(0.57 * 0.63, 10); expect(r.p01).toBeCloseTo(0.37 * 0.43, 10);
  const c = discordantRates(0.37, 0.57, 0.5); // correlated outcomes: fewer discordant pairs
  expect(c.p10 + c.p01).toBeLessThan(r.p10 + r.p01);
  expect(() => discordantRates(0.9, 0.1, 0.99)).toThrow(); // impossible joint distribution
});

it('the exact sign-flip test on binary paired differences is the exact one-sided McNemar test', () => {
  for (const [b, c] of [[6, 0], [7, 2], [3, 3], [10, 4]]) {
    const diffs = [...Array(b).fill(1), ...Array(c).fill(-1), 0, 0];
    expect(signFlipPValue(diffs)).toBeCloseTo(mcnemarOneSided(b, c), 12);
  }
});

it('exact McNemar power is monotone in n and in the effect, and is 0 when no outcome can be significant', () => {
  const { p10, p01 } = discordantRates(0.37, 0.57);
  const p20 = mcnemarExactPower(20, p10, p01, 0.05); const p60 = mcnemarExactPower(60, p10, p01, 0.05);
  expect(p20).toBeGreaterThan(0.1); expect(p20).toBeLessThan(0.4); expect(p60).toBeGreaterThan(p20);
  expect(mcnemarExactPower(3, p10, p01, 0.05)).toBe(0); // 3 vs 0 discordant: p = 0.125
  const big = discordantRates(0.37, 0.77);
  expect(mcnemarExactPower(20, big.p10, big.p01, 0.05)).toBeGreaterThan(p20);
});

it('task-family clustering: design effect 1 + (m_w - 1)·ICC with a size-weighted family size', () => {
  expect(designEffect([1, 1, 1, 1], 0.3)).toBe(1);
  expect(designEffect([4, 4], 0.1)).toBeCloseTo(1.3, 10);
  expect(designEffect([3, 1, 1], 0.2)).toBeCloseTo(1 + (11 / 5 - 1) * 0.2, 10);
});

it('the report: power at n, at the cluster-effective n, and the n reaching the target', () => {
  const r = pairedPowerReport({ n: 20, p0: 0.37, p1: 0.57, alpha: 0.05, rho: 0, clusterSizes: [3, 2, ...Array(15).fill(1)], icc: 0.1 });
  expect(r.expected_discordant).toBeCloseTo(20 * (0.57 * 0.63 + 0.37 * 0.43), 6);
  expect(r.n_effective).toBeLessThan(20);
  expect(r.power_effective).toBeLessThanOrEqual(r.power);
  expect(r.n_for_target).not.toBeNull();
  expect(mcnemarExactPower(r.n_for_target!, r.p10, r.p01, 0.05)).toBeGreaterThanOrEqual(0.8);
});

// E-assumptions A4/C13 (re-20261030): holdout-power.ts read a missing rho or ICC as 0 (independent outcomes, no clustering) —
// an assumption reported as a power. Unknown is not 0: the power that depends on it is null and the report names what is missing.
it('a missing rho gives no power; a missing ICC with task families gives no clustered power (null, never the rho/ICC = 0 numbers)', () => {
  const noRho = pairedPowerReport({ n: 20, p0: 0.37, p1: 0.57 });
  expect(noRho).toMatchObject({ rho: null, p10: null, p01: null, expected_discordant: null, power: null, power_effective: null, n_for_target: null, n_for_target_clustered: null });
  expect(noRho.missing_assumptions).toEqual(['rho']);
  const noIcc = pairedPowerReport({ n: 20, p0: 0.37, p1: 0.57, rho: 0, clusterSizes: [3, 2, ...Array(15).fill(1)] });
  expect(noIcc.power).toBeGreaterThan(0); // rho stated: the unclustered power is known
  expect(noIcc).toMatchObject({ icc: null, design_effect: null, n_effective: null, power_effective: null, n_for_target_clustered: null });
  expect(noIcc.n_for_target).not.toBeNull();
  expect(noIcc.missing_assumptions).toEqual(['icc']);
  // no task families declared: no clustering to correct for (design effect 1), nothing missing
  expect(pairedPowerReport({ n: 20, p0: 0.37, p1: 0.57, rho: 0 })).toMatchObject({ design_effect: 1, n_effective: 20, missing_assumptions: [] });
});
