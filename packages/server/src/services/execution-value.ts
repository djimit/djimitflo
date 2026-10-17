/**
 * DI-001 (offline only, docs/research/di-001/EXECUTION_VALUE_PREREG.md): expected execution value
 *   EV(run) = P(success | lane, kind, dir, history) · V − λ · E[cost]
 * and three budgeted replays over runs that actually executed: A (chronological, what ran), B (EV order), C (B with a
 * protected-exploration floor). Pure: no database, no clock, no randomness except the seeded bootstrap. Nothing in the
 * server imports this module; no scheduler reads it.
 *
 * Leak boundary: fitEvModel() sees only rows created AND labelled before the cutoff; predict()/rank*() see features
 * only. Realised cost and labels of evaluated runs enter only the evaluator (selectUnderBudget / metrics).
 */

export interface EvFeatures { id: string; created_at: string; lane: string; kind: string; dir: string; target: string }
/** A fit-period row. label_at: when y became observable (prereg §3); y null = NA. */
export interface FitRow { f: EvFeatures; y: 0 | 1 | null; cost: number | null; label_at: string | null }

interface Cell { n: number; k: number; costN: number; costSum: number }
export interface EvModel {
  cutoff: string; m: number; globalP: number; globalCost: number; lambda: number;
  cells: Record<string, Cell>; fitTargets: string[]; n_fit_labelled: number; n_fit_cost: number;
}
export interface EvPrediction { id: string; created_at: string; p: number; sd: number; cost: number; ev: number; n_cell: number; novel: boolean }

const levels = (f: EvFeatures): string[] => [`L:${f.lane}`, `K:${f.lane}|${f.kind}`, `D:${f.lane}|${f.kind}|${f.dir}`];
const pairKey = (f: EvFeatures) => `${f.lane}|${f.target}`;

/** Fit once (prereg §5). Rows created or labelled at/after the cutoff are dropped here, whatever the caller passes. */
export function fitEvModel(rows: FitRow[], cutoff: string, m = 4): EvModel {
  const fit = rows.filter((r) => r.f.created_at < cutoff);
  const cells: Record<string, Cell> = {};
  const cell = (k: string) => (cells[k] ??= { n: 0, k: 0, costN: 0, costSum: 0 });
  let n = 0; let k = 0; let costN = 0; let costSum = 0; let kCostKnown = 0;
  for (const r of fit) {
    const labelled = r.y !== null && r.label_at !== null && r.label_at < cutoff;
    const costKnown = r.cost !== null && Number.isFinite(r.cost);
    for (const key of levels(r.f)) {
      const c = cell(key);
      if (labelled) { c.n++; c.k += r.y as number; }
      if (costKnown) { c.costN++; c.costSum += r.cost as number; }
    }
    if (labelled) { n++; k += r.y as number; if (costKnown) kCostKnown += r.y as number; }
    if (costKnown) { costN++; costSum += r.cost as number; }
  }
  const globalP = (1 + k) / (2 + n);
  const globalCost = costN ? costSum / costN : 1;
  return { cutoff, m, globalP, globalCost, lambda: costSum > 0 ? kCostKnown / costSum : 0, cells,
    fitTargets: [...new Set(fit.map((r) => pairKey(r.f)))].sort(), n_fit_labelled: n, n_fit_cost: costN };
}

/** Prediction from features alone (V = 1). */
export function predict(model: EvModel, f: EvFeatures): EvPrediction {
  let p = model.globalP; let cost = model.globalCost; let nDeep = 0; let nCell = 0;
  for (const key of levels(f)) {
    const c = model.cells[key];
    const cn = c?.n ?? 0;
    p = ((c?.k ?? 0) + model.m * p) / (cn + model.m);
    cost = ((c?.costSum ?? 0) + model.m * cost) / ((c?.costN ?? 0) + model.m);
    nDeep = cn; if (cn > 0) nCell = cn;
  }
  const sd = Math.sqrt((p * (1 - p)) / (nDeep + model.m + 1));
  const novel = nDeep === 0 || !model.fitTargets.includes(pairKey(f));
  const r6 = (x: number) => +x.toFixed(6);
  return { id: f.id, created_at: f.created_at, p: r6(p), sd: r6(sd), cost: r6(cost), ev: r6(p - model.lambda * cost), n_cell: nCell, novel };
}

const byTime = (a: { created_at: string; id: string }, b: { created_at: string; id: string }) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
/** A: what ran, in the order it ran. */
export const orderA = <T extends { created_at: string; id: string }>(xs: T[]): T[] => [...xs].sort(byTime);
/** B: EV descending; ties by created_at then id. */
export const orderB = (ps: EvPrediction[]): EvPrediction[] => [...ps].sort((a, b) => b.ev - a.ev || byTime(a, b));

const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };

/** C's protected pool (prereg §6): novel, sd ≥ median sd, or p̂ in the bottom tercile. `difficult` is M3's stratum. */
export function protectedPool(ps: EvPrediction[]): { protectedIds: Set<string>; difficultIds: Set<string> } {
  const medSd = quantile(ps.map((p) => p.sd), 0.5);
  const lowP = quantile(ps.map((p) => p.p), 1 / 3);
  const sorted = [...ps].sort((a, b) => a.p - b.p || byTime(a, b));
  // bottom tercile by rank (ties at the boundary would otherwise pull in most of a flat distribution)
  const difficultIds = new Set(sorted.slice(0, Math.ceil(ps.length / 3)).filter((p) => p.p <= lowP).map((p) => p.id));
  const protectedIds = new Set(ps.filter((p) => p.novel || p.sd >= medSd || difficultIds.has(p.id)).map((p) => p.id));
  return { protectedIds, difficultIds };
}

/** Evaluator: walk an order, include a run when it still fits the budget, else skip it and continue. */
export function selectUnderBudget(order: string[], costOf: (id: string) => number, budget: number, taken = new Set<string>()): { ids: string[]; spent: number } {
  const ids: string[] = []; let spent = 0;
  for (const id of order) {
    if (taken.has(id)) continue;
    const c = costOf(id);
    if (spent + c <= budget + 1e-12) { ids.push(id); spent += c; taken.add(id); }
  }
  return { ids, spent };
}

/** C: phase 1 spends up to X·budget on protected runs by sd descending; phase 2 fills the rest by EV. */
export function policyC(ps: EvPrediction[], costOf: (id: string) => number, budget: number, x = 0.2): { ids: string[]; spent: number; protected_spent: number } {
  const { protectedIds } = protectedPool(ps);
  const pool = ps.filter((p) => protectedIds.has(p.id)).sort((a, b) => b.sd - a.sd || byTime(a, b)).map((p) => p.id);
  const taken = new Set<string>();
  const one = selectUnderBudget(pool, costOf, x * budget, taken);
  const two = selectUnderBudget(orderB(ps).map((p) => p.id), costOf, budget - one.spent, taken);
  return { ids: [...one.ids, ...two.ids], spent: one.spent + two.spent,
    protected_spent: [...one.ids, ...two.ids].filter((id) => protectedIds.has(id)).reduce((a, id) => a + costOf(id), 0) };
}

/** Evaluation-only facts about a run (never passed to fit/predict/rank). */
export interface EvOutcome { id: string; y: 0 | 1 | null; cost: number; cost_imputed: boolean; latency_h: number | null; merged: boolean; regressed: boolean; first_pair: boolean; arms: string[] }
export interface PolicyMetrics {
  selected: number; spent_m: number; successes: number; failures: number; na: number;
  m1_success_per_m: number | null; m2_new_capability_successes: number; m2_first_pairs_executed: number; m2_first_cells_executed: number;
  m3_difficult_count_share: number | null; m3_difficult_cost_share: number | null; m4_negative_per_m: number | null;
  m5_settled_regressed: number; m5_oracle_or_label_failure_share: number | null; m6_median_latency_h: number | null;
  m7_na_share: number | null; m7_smd_p: number | null; m7_smd_cost: number | null; m7_smd_novel: number | null; m7_arm_share: Record<string, number>;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sdOf = (xs: number[]) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const smd = (sel: number[], pool: number[]) => { const s = Math.sqrt((sdOf(sel) ** 2 + sdOf(pool) ** 2) / 2); return sel.length && s > 0 ? +((mean(sel) - mean(pool)) / s).toFixed(3) : null; };
const r4 = (x: number | null) => (x === null || !Number.isFinite(x) ? null : +x.toFixed(4));

export function metrics(ids: string[], ps: EvPrediction[], outcomes: Map<string, EvOutcome>, difficultIds: Set<string>, cellOf: (id: string) => string, fitCells: Set<string>): PolicyMetrics {
  const sel = ids.map((id) => outcomes.get(id)!);
  const spent = sel.reduce((a, o) => a + o.cost, 0);
  const succ = sel.filter((o) => o.y === 1); const fail = sel.filter((o) => o.y === 0); const na = sel.filter((o) => o.y === null);
  const lat = succ.map((o) => o.latency_h).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const pMap = new Map(ps.map((p) => [p.id, p]));
  const selP = ids.map((id) => pMap.get(id)!);
  const diffSel = ids.filter((id) => difficultIds.has(id));
  const diffCostAll = [...difficultIds].reduce((a, id) => a + (outcomes.get(id)?.cost ?? 0), 0);
  const armShare: Record<string, number> = {};
  for (const o of sel) for (const a of o.arms) armShare[a] = (armShare[a] ?? 0) + 1;
  for (const a of Object.keys(armShare)) armShare[a] = +(armShare[a] / Math.max(1, sel.length)).toFixed(3);
  return {
    selected: ids.length, spent_m: r4(spent) ?? 0, successes: succ.length, failures: fail.length, na: na.length,
    m1_success_per_m: spent > 0 ? r4(succ.length / spent) : null,
    m2_new_capability_successes: succ.filter((o) => o.first_pair).length,
    m2_first_pairs_executed: sel.filter((o) => o.first_pair).length,
    m2_first_cells_executed: new Set(ids.map(cellOf).filter((c) => !fitCells.has(c))).size,
    m3_difficult_count_share: difficultIds.size ? r4(diffSel.length / difficultIds.size) : null,
    m3_difficult_cost_share: diffCostAll > 0 ? r4(diffSel.reduce((a, id) => a + outcomes.get(id)!.cost, 0) / diffCostAll) : null,
    m4_negative_per_m: spent > 0 ? r4(fail.length / spent) : null,
    m5_settled_regressed: sel.filter((o) => o.regressed).length,
    m5_oracle_or_label_failure_share: succ.length + fail.length ? r4(fail.length / (succ.length + fail.length)) : null,
    m6_median_latency_h: lat.length ? r4(lat[Math.floor((lat.length - 1) / 2)]) : null,
    m7_na_share: sel.length ? r4(na.length / sel.length) : null,
    m7_smd_p: smd(selP.map((p) => p.p), ps.map((p) => p.p)), m7_smd_cost: smd(selP.map((p) => p.cost), ps.map((p) => p.cost)),
    m7_smd_novel: smd(selP.map((p) => +p.novel), ps.map((p) => +p.novel)), m7_arm_share: armShare,
  };
}

/** One replay of A, B and C at budget fraction f over the given eval predictions. */
export function replay(ps: EvPrediction[], costOf: (id: string) => number, f: number, x = 0.2) {
  const total = ps.reduce((a, p) => a + costOf(p.id), 0);
  const budget = f * total;
  const A = selectUnderBudget(orderA(ps).map((p) => p.id), costOf, budget);
  const B = selectUnderBudget(orderB(ps).map((p) => p.id), costOf, budget);
  const C = policyC(ps, costOf, budget, x);
  return { budget, total, A, B, C };
}

/** mulberry32 (same as gym-mutants.rng), inlined to keep this module dependency-free. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * Paired bootstrap of M1(B) − M1(A) and M1(C) − M1(A) (prereg §8). Each resample draws eval runs with replacement
 * (duplicates get distinct ids) and re-runs every policy; the model is fixed.
 */
export function bootstrapM1(ps: EvPrediction[], outcomes: Map<string, EvOutcome>, f: number, boot = 2000, seed = 7, x = 0.2) {
  const r = seeded(seed); const dB: number[] = []; const dC: number[] = [];
  for (let b = 0; b < boot; b++) {
    const sample = ps.map(() => ps[Math.floor(r() * ps.length)]).map((p, i) => ({ ...p, id: `${p.id}#${i}` }));
    const base = (id: string) => id.slice(0, id.lastIndexOf('#'));
    const costOf = (id: string) => outcomes.get(base(id))!.cost;
    const m1 = (ids: string[]) => { const s = ids.reduce((a, id) => a + costOf(id), 0); return s > 0 ? ids.filter((id) => outcomes.get(base(id))!.y === 1).length / s : 0; };
    const { A, B, C } = replay(sample, costOf, f, x);
    dB.push(m1(B.ids) - m1(A.ids)); dC.push(m1(C.ids) - m1(A.ids));
  }
  const ci = (d: number[]): [number, number] => { const s = [...d].sort((a, b) => a - b); return [+s[Math.floor(0.025 * boot)].toFixed(4), +s[Math.ceil(0.975 * boot) - 1].toFixed(4)]; };
  return { b_minus_a: ci(dB), c_minus_a: ci(dC) };
}

/**
 * Exploratory (not pre-registered; reported as such): A under a random order instead of the chronological one. The
 * chronological A carries any time trend of the eval window; a random order is what A's own runs give when order is
 * exchangeable. Returns the percentile band of M1 over `n` seeded permutations and the share of them `m1` beats.
 */
export function randomOrderM1(ps: EvPrediction[], outcomes: Map<string, EvOutcome>, f: number, m1: number, n = 2000, seed = 11) {
  const r = seeded(seed); const costOf = (id: string) => outcomes.get(id)!.cost;
  const budget = f * ps.reduce((a, p) => a + costOf(p.id), 0); const vals: number[] = [];
  for (let i = 0; i < n; i++) {
    const ids = ps.map((p) => p.id);
    for (let j = ids.length - 1; j > 0; j--) { const k = Math.floor(r() * (j + 1)); [ids[j], ids[k]] = [ids[k], ids[j]]; }
    const sel = selectUnderBudget(ids, costOf, budget);
    vals.push(sel.spent > 0 ? sel.ids.filter((id) => outcomes.get(id)!.y === 1).length / sel.spent : 0);
  }
  vals.sort((a, b) => a - b);
  return { mean: +mean(vals).toFixed(4), band95: [+vals[Math.floor(0.025 * n)].toFixed(4), +vals[Math.ceil(0.975 * n) - 1].toFixed(4)] as [number, number],
    share_beaten: +(vals.filter((v) => m1 > v).length / n).toFixed(4) };
}

export type EvVerdict = 'INSUFFICIENT' | 'INCONCLUSIVE' | 'SUPPORTED_OFFLINE' | 'NOT_SUPPORTED';
/** Prereg §9. */
export function verdict(labelled: number, successes: number, ci: [number, number], m3Ok = true): EvVerdict {
  if (labelled < 60 || successes < 15) return 'INSUFFICIENT';
  if (ci[0] > 0) return m3Ok ? 'SUPPORTED_OFFLINE' : 'INCONCLUSIVE';
  if (ci[1] < 0) return 'NOT_SUPPORTED';
  return 'INCONCLUSIVE';
}
