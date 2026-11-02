/**
 * Pure paired tests on discordant pairs, shared by genome trials (dream-evolution, which re-exports them) and PL-001 (pl-001).
 * A leaf module: it imports nothing, so an experiment module can use it without pulling in the gym service graph.
 *
 * Z5: exact one-sided McNemar — P(X >= b | n = b + c, 1/2), b = the candidate's wins among the discordant pairs.
 */
export function mcnemarOneSided(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  let p = 0; let coef = 1; // C(n, 0)
  for (let k = 0; k <= n; k++) { if (k >= b) p += coef; coef = coef * (n - k) / (k + 1); }
  return p / 2 ** n;
}

/**
 * RX-13 (Phase F): an anytime-valid alternative to McNemar on the discordant pairs. The e-value of a one-sided uniform(1/2, 1)
 * mixture over the win probability: E(n, k) = 2^(n+1) · k!(n−k)!/(n+1)! · P(Bin(n+1, 1/2) <= k), k = wins among n discordant
 * pairs. By Ville's inequality it stays valid when looked at after every pair; it is exchangeable (order does not matter).
 */
const logFact = (n: number): number => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };
export function eValue(n: number, k: number): number {
  if (n <= 0) return 1;
  const terms = Array.from({ length: k + 1 }, (_, i) => logFact(n + 1) - logFact(i) - logFact(n + 1 - i));
  const max = Math.max(...terms);
  const logCdf = max + Math.log(terms.reduce((a, t) => a + Math.exp(t - max), 0)) - (n + 1) * Math.LN2;
  return Math.exp((n + 1) * Math.LN2 + logFact(k) + logFact(n - k) - logFact(n + 1) + logCdf);
}
export const ePaired = (pairs: Array<1 | -1>): number => eValue(pairs.length, pairs.filter((p) => p === 1).length);
