/** ASG-001 pre-registered statistics (PREREG.md §5). Pure functions; seeded, so every number is reproducible. */

/** mulberry32: a small seeded PRNG */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function shuffle<T>(xs: T[], seed: number): T[] { const r = rng(seed); const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

const logChoose = (n: number, k: number): number => { let s = 0; for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i); return s; };
/** Exact McNemar: two-sided binomial test on the discordant pairs b (first arm only) and c (second arm only). */
export function mcnemarExact(b: number, c: number): { b: number; c: number; n_discordant: number; p: number } {
  const n = b + c; if (n === 0) return { b, c, n_discordant: 0, p: 1 };
  const k = Math.min(b, c); let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return { b, c, n_discordant: n, p: Math.min(1, 2 * tail) };
}

export function wilson(k: number, n: number, z = 1.959963984540054): [number, number] | null {
  if (!n) return null;
  const p = k / n; const d = 1 + z * z / n; const c = p + z * z / (2 * n); const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}

/**
 * Newcombe (1998) method 10 (hybrid score, no continuity correction) for the paired difference p1 − p2.
 * Cells: a = both succeed, b = arm 1 only, c = arm 2 only, d = neither.
 */
export function newcombePaired(a: number, b: number, c: number, d: number): { diff: number; ci: [number, number] } | null {
  const n = a + b + c + d; if (!n) return null;
  const p1 = (a + b) / n; const p2 = (a + c) / n;
  const [l1, u1] = wilson(a + b, n)!; const [l2, u2] = wilson(a + c, n)!;
  const den = Math.sqrt((a + b) * (c + d) * (a + c) * (b + d));
  const phi = den === 0 ? 0 : (a * d - b * c) / den;
  const dl = Math.sqrt(Math.max(0, (p1 - l1) ** 2 - 2 * phi * (p1 - l1) * (u2 - p2) + (u2 - p2) ** 2));
  const du = Math.sqrt(Math.max(0, (u1 - p1) ** 2 - 2 * phi * (u1 - p1) * (p2 - l2) + (p2 - l2) ** 2));
  const diff = p1 - p2;
  return { diff, ci: [Math.max(-1, diff - dl), Math.min(1, diff + du)] };
}

export interface CostRow { cluster: string; cost: number; success: boolean }
/** Cost per verified success: ratio of sums over every attempt; zero successes → +∞ (never 0). */
export const costPerSuccess = (rows: CostRow[]): number => { const s = rows.filter((r) => r.success).length; const c = rows.reduce((x, r) => x + r.cost, 0); return s === 0 ? Infinity : c / s; };

const pct = (xs: number[], q: number): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1) + 0.5)))]; };

/** Cluster bootstrap (resampling clusters = task families with replacement), percentile 95 % CI; +∞ draws stay +∞. */
export function clusterBootstrap(rows: CostRow[], stat: (rs: CostRow[]) => number, draws = 10_000, seed = 20261024): { estimate: number; ci: [number, number] | null; draws: number; infinite_draws: number } {
  const clusters = [...new Set(rows.map((r) => r.cluster))].sort();
  const by = new Map(clusters.map((c) => [c, rows.filter((r) => r.cluster === c)]));
  const estimate = stat(rows);
  if (clusters.length < 2) return { estimate, ci: null, draws: 0, infinite_draws: 0 };
  const r = rng(seed); const vals: number[] = [];
  for (let i = 0; i < draws; i++) { const sample: CostRow[] = []; for (let j = 0; j < clusters.length; j++) sample.push(...by.get(clusters[Math.floor(r() * clusters.length)])!); vals.push(stat(sample)); }
  return { estimate, ci: [pct(vals, 0.025), pct(vals, 0.975)], draws, infinite_draws: vals.filter((v) => !Number.isFinite(v)).length };
}

/** Ratio of cost per success, arm X / arm Y, with the same cluster draws for both arms (paired by family). */
export function pairedRatioBootstrap(x: CostRow[], y: CostRow[], draws = 10_000, seed = 20261024): { estimate: number; ci: [number, number] | null } {
  const clusters = [...new Set([...x, ...y].map((r) => r.cluster))].sort();
  const ratio = (cs: string[]) => { const xs = cs.flatMap((c) => x.filter((r) => r.cluster === c)); const ys = cs.flatMap((c) => y.filter((r) => r.cluster === c)); const a = costPerSuccess(xs); const b = costPerSuccess(ys); return !Number.isFinite(b) ? (Number.isFinite(a) ? 0 : NaN) : a / b; };
  const estimate = ratio(clusters);
  if (clusters.length < 2) return { estimate, ci: null };
  const r = rng(seed); const vals: number[] = [];
  for (let i = 0; i < draws; i++) { const cs: string[] = []; for (let j = 0; j < clusters.length; j++) cs.push(clusters[Math.floor(r() * clusters.length)]); const v = ratio(cs); if (!Number.isNaN(v)) vals.push(v); }
  return { estimate, ci: vals.length ? [pct(vals, 0.025), pct(vals, 0.975)] : null };
}
