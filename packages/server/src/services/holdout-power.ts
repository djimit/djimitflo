import { mcnemarOneSided } from './dream-evolution';

/**
 * Holdout epoch 1 (14-10): what a paired holdout of n tasks can show — reported by the freeze script, never used to size a
 * holdout automatically. Paired design: parent and mutant run the same tasks; only discordant pairs carry information.
 * - discordantRates: P(mutant passes, parent fails) = p10 and the reverse p01, from the marginal pass rates and the
 *   within-task correlation rho (phi coefficient; 0 = independent outcomes, the conservative-for-discordance assumption);
 * - mcnemarExactPower: exact power of the one-sided exact McNemar test the promotion rule uses (dream-evolution
 *   mcnemarOneSided, p < alpha), summing over the number of discordant pairs D ~ Bin(n, p10 + p01);
 * - signFlipPValue: exact one-sided sign-flip (paired permutation) p-value; on binary differences it IS the exact McNemar;
 * - designEffect: tasks from one family (same source file) are not independent: deff = 1 + (m_w − 1)·ICC with m_w the
 *   size-weighted mean family size; n_effective = n / deff.
 */
export function discordantRates(p0: number, p1: number, rho = 0): { p10: number; p01: number } {
  const p11 = p0 * p1 + rho * Math.sqrt(p0 * (1 - p0) * p1 * (1 - p1));
  const p10 = p1 - p11; const p01 = p0 - p11; const p00 = 1 - p10 - p01 - p11;
  if ([p11, p10, p01, p00].some((p) => p < -1e-12)) throw new Error(`no joint distribution with p0=${p0}, p1=${p1}, rho=${rho}`);
  return { p10: Math.max(0, p10), p01: Math.max(0, p01) };
}

const binom = (n: number, k: number, p: number): number => {
  if (p <= 0) return k === 0 ? 1 : 0; if (p >= 1) return k === n ? 1 : 0;
  let lc = 0; for (let i = 1; i <= k; i++) lc += Math.log(n - k + i) - Math.log(i);
  return Math.exp(lc + k * Math.log(p) + (n - k) * Math.log(1 - p));
};

export function mcnemarExactPower(n: number, p10: number, p01: number, alpha = 0.05): number {
  const pd = p10 + p01; if (pd <= 0) return 0;
  const q = p10 / pd; let power = 0;
  for (let d = 1; d <= n; d++) {
    let bMin = -1; for (let b = 0; b <= d; b++) if (mcnemarOneSided(b, d - b) < alpha) { bMin = b; break; }
    if (bMin < 0) continue;
    let tail = 0; for (let b = bMin; b <= d; b++) tail += binom(d, b, q);
    power += binom(n, d, pd) * tail;
  }
  return Math.min(1, power);
}

/** Exact one-sided sign-flip p-value: share of the 2^k sign assignments of the k non-zero differences with sum ≥ observed. */
export function signFlipPValue(diffs: number[]): number {
  const d = diffs.filter((x) => x !== 0); const k = d.length; if (!k) return 1;
  if (k > 24) throw new Error('signFlipPValue: exact enumeration is limited to 24 non-zero differences');
  const obs = d.reduce((a, x) => a + x, 0); let hits = 0;
  for (let mask = 0; mask < 2 ** k; mask++) {
    let s = 0; for (let i = 0; i < k; i++) s += (mask >> i) & 1 ? -Math.abs(d[i]) : Math.abs(d[i]);
    if (s >= obs - 1e-12) hits++;
  }
  return hits / 2 ** k;
}

export function designEffect(clusterSizes: number[], icc: number): number {
  const total = clusterSizes.reduce((a, m) => a + m, 0); if (!total) return 1;
  const mw = clusterSizes.reduce((a, m) => a + m * m, 0) / total;
  return 1 + (mw - 1) * icc;
}

export interface PairedPowerInput { n: number; p0: number; p1: number; alpha?: number; rho?: number; clusterSizes?: number[]; icc?: number; target?: number; maxN?: number }
/**
 * E-assumptions A4/C13 (re-20261030): rho and ICC are assumptions the caller states; a missing one is unknown, never 0. Without
 * rho no discordance, power or n is reported (null); with task families (clusterSizes) but no ICC the clustered numbers are null.
 * No clusterSizes = no task families declared: design effect 1. missing_assumptions names what is missing.
 */
export function pairedPowerReport(i: PairedPowerInput) {
  const alpha = i.alpha ?? 0.05; const target = i.target ?? 0.8;
  const missing = [...(i.rho === undefined ? ['rho'] : []), ...(i.clusterSizes && i.icc === undefined ? ['icc'] : [])];
  const rates = i.rho === undefined ? null : discordantRates(i.p0, i.p1, i.rho);
  const deff = !i.clusterSizes ? 1 : i.icc === undefined ? null : designEffect(i.clusterSizes, i.icc);
  const nEff = deff === null ? null : Math.max(1, Math.floor(i.n / deff));
  let nForTarget: number | null = null;
  // exact power is saw-toothed in n: report the smallest n from which it stays ≥ target over the next 10
  if (rates) for (let n = 1; n <= (i.maxN ?? 400) && nForTarget === null; n++) {
    let ok = true; for (let k = n; k < n + 10 && ok; k++) ok = mcnemarExactPower(k, rates.p10, rates.p01, alpha) >= target;
    if (ok) nForTarget = n;
  }
  return {
    n: i.n, p0: i.p0, p1: i.p1, alpha, rho: i.rho ?? null, icc: i.icc ?? null, missing_assumptions: missing,
    p10: rates ? +rates.p10.toFixed(10) : null, p01: rates ? +rates.p01.toFixed(10) : null,
    expected_discordant: rates ? +(i.n * (rates.p10 + rates.p01)).toFixed(10) : null, power: rates ? +mcnemarExactPower(i.n, rates.p10, rates.p01, alpha).toFixed(4) : null,
    design_effect: deff === null ? null : +deff.toFixed(4), n_effective: nEff,
    power_effective: rates && nEff !== null ? +mcnemarExactPower(nEff, rates.p10, rates.p01, alpha).toFixed(4) : null,
    target, n_for_target: nForTarget, n_for_target_clustered: nForTarget === null || deff === null ? null : Math.ceil(nForTarget * deff),
  };
}
