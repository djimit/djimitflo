import type { Database } from 'better-sqlite3';

/**
 * B8 (Batch-8, ATLAS / Agent-Psychometrics idea): a 2PL item-response model of the gym. Prod 06-10: only 27 % of gym tasks
 * have 0 < pass < 1 and tiers 1–6 pass 83–100 %, so trials on randomly frozen tasks are blind. Fitting difficulty (b) and
 * discrimination (a) per task from the task × respondent history shows which tasks carry information about a maker's
 * ability (θ) — and lets a new holdout epoch freeze the most informative ones (GYM_IRT_SELECTION, default off).
 * Respondent = gym species × strategy genome (ordinary attempts run the baseline). No dependency: MAP by gradient ascent.
 */
export interface Observation { item: string; respondent: string; y: 0 | 1 }
export type ItemFlag = 'ok' | 'non_discriminating' | 'negative' | 'insufficient';
export interface IrtItem { key: string; n: number; pass_rate: number; a: number; b: number; flag: ItemFlag }
export interface IrtFit { items: IrtItem[]; abilities: Record<string, number> }

export const irtSelectionEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.GYM_IRT_SELECTION === 'true';
export const respondentKey = (species: string, genome?: string | null): string => `${species}|${genome || 'baseline'}`;

/** Scored gym attempts (success / failure; discarded, canaries and probes left out) as IRT observations. */
export function gymObservations(db: Database, sinceIso = '1970-01-01'): Observation[] {
  try {
    return (db.prepare(`SELECT json_extract(metadata, '$.gym.commit') AS item, json_extract(metadata, '$.gym.species') AS species,
        json_extract(metadata, '$.gym.genome') AS genome, json_extract(metadata, '$.gym_result.status') = 'success' AS ok
      FROM loop_runs WHERE loop_name = 'evolution-gym' AND created_at >= ? AND json_extract(metadata, '$.gym_result.status') IN ('success', 'failure')
        AND json_extract(metadata, '$.gym.canary') IS NULL AND json_extract(metadata, '$.gym.probe') IS NULL
        AND json_extract(metadata, '$.gym.commit') IS NOT NULL AND json_extract(metadata, '$.gym.species') IS NOT NULL`).all(sinceIso) as
      Array<{ item: string; species: string; genome: string | null; ok: number }>)
      .map((r) => ({ item: r.item, respondent: respondentKey(r.species, r.genome), y: r.ok ? 1 : 0 }));
  } catch { return []; }
}

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));
export const probability = (a: number, b: number, theta: number): number => sigmoid(a * (theta - b));
/** Fisher information of a 2PL item at ability θ: a² p (1 − p). */
export const fisherInformation = (a: number, b: number, theta: number): number => { const p = probability(a, b, theta); return a * a * p * (1 - p); };

/**
 * Joint MAP fit: θ ~ N(0, 1), b ~ N(0, 2²), a ~ N(1, 1) (a may go negative — that is a finding, not an error).
 * Deterministic: starts from θ = 0, a = 1, b = −logit(smoothed pass rate); fixed step and iteration count.
 */
export function fitIrt(obs: Observation[], iterations = 600, step = 0.05): IrtFit {
  const itemKeys = [...new Set(obs.map((o) => o.item))].sort();
  const respKeys = [...new Set(obs.map((o) => o.respondent))].sort();
  const ii = new Map(itemKeys.map((k, i) => [k, i])); const ri = new Map(respKeys.map((k, i) => [k, i]));
  const n = itemKeys.map(() => 0); const ok = itemKeys.map(() => 0); const nr = respKeys.map(() => 0);
  const rows = obs.map((o) => { const i = ii.get(o.item)!; const j = ri.get(o.respondent)!; n[i]++; ok[i] += o.y; nr[j]++; return { i, j, y: o.y }; });
  const a = itemKeys.map(() => 1);
  const b = itemKeys.map((_, i) => { const p = (ok[i] + 0.5) / (n[i] + 1); return -Math.log(p / (1 - p)); });
  const theta = respKeys.map(() => 0);
  for (let it = 0; it < iterations; it++) {
    const ga = a.map((x) => -(x - 1)); const gb = b.map((x) => -x / 4); const gt = theta.map((x) => -x);
    for (const { i, j, y } of rows) {
      const r = y - probability(a[i], b[i], theta[j]);
      ga[i] += (theta[j] - b[i]) * r; gb[i] -= a[i] * r; gt[j] += a[i] * r;
    }
    for (let i = 0; i < a.length; i++) { a[i] += step * ga[i] / Math.max(1, n[i]) * 4; b[i] += step * gb[i] / Math.max(1, n[i]) * 4; }
    for (let j = 0; j < theta.length; j++) theta[j] += step * gt[j] / Math.max(1, nr[j]) * 4;
  }
  const items = itemKeys.map((key, i) => {
    const same = ok[i] === 0 || ok[i] === n[i];
    const flag: ItemFlag = n[i] < 2 ? 'insufficient' : same ? 'non_discriminating' : a[i] < 0 ? 'negative' : a[i] < 0.3 ? 'non_discriminating' : 'ok';
    return { key, n: n[i], pass_rate: +(ok[i] / n[i]).toFixed(4), a: +a[i].toFixed(3), b: +b[i].toFixed(3), flag };
  });
  return { items, abilities: Object.fromEntries(respKeys.map((k, j) => [k, +theta[j].toFixed(3)])) };
}

/** The k discriminating items with the most Fisher information at θ (ties by key), never one of `exclude`. */
export function pickInformativeItems(items: IrtItem[], theta: number, k: number, exclude: Iterable<string> = []): IrtItem[] {
  const skip = new Set(exclude);
  return items.filter((it) => it.flag === 'ok' && !skip.has(it.key))
    .map((it) => ({ it, info: fisherInformation(it.a, it.b, theta) }))
    .sort((x, y) => y.info - x.info || x.it.key.localeCompare(y.it.key)).slice(0, Math.max(0, k)).map((x) => x.it);
}

/** Counts by flag and the most informative items at a respondent's θ (default: the evolving species' baseline). */
export function irtSummary(db: Database, env: NodeJS.ProcessEnv = process.env, top = 10) {
  const fit = fitIrt(gymObservations(db));
  const parent = respondentKey(env.DREAM_EVOLUTION_SPECIES || 'atomic@llama-router');
  const theta = fit.abilities[parent] ?? 0;
  const counts = { ok: 0, non_discriminating: 0, negative: 0, insufficient: 0 } as Record<ItemFlag, number>;
  for (const it of fit.items) counts[it.flag]++;
  return { items: fit.items.length, counts, parent, theta, top: pickInformativeItems(fit.items, theta, top).map((it) => ({ key: it.key, a: it.a, b: it.b, info: +fisherInformation(it.a, it.b, theta).toFixed(4) })) };
}
