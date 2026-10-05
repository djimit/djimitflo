import type { Database } from 'better-sqlite3';
import type { Species } from './evolve-selection';
import { speciesKey } from './runtime-bandit';
import { LoopEventService } from './loop-event-service';

/**
 * D0 (Darwin engine, operator-approved 03-10): one fitness view over skill_outcomes for a maker species in a lane. The bandit
 * read only `loop-maker:<lane>:<runtime>`, so gym wins (`loop-maker:gym:*`) and merge survival (`loop-maker:merge:*`,
 * EV4) never reached selection. Sources are weighted, not pooled: production 1, gym 0.25 (a different task: fixing one
 * source file, not writing a test — the 81 %-gym species scored 0/9 on real work), merge 3 (delayed, human, hardest to
 * game). Every outcome decays with a half-life (default 30 d) so selection follows a changing population.
 * SHADOW ONLY (FITNESS_SHADOW_ENABLED): the posterior is recorded next to the bandit's real choice; nothing acts on it.
 */
export type FitnessSource = 'production' | 'gym' | 'merge';
const num = (v: string | undefined, d: number) => (v !== undefined && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
export const fitnessWeights = (env: NodeJS.ProcessEnv = process.env): Record<FitnessSource, number> =>
  ({ production: 1, gym: num(env.FITNESS_W_GYM, 0.25), merge: num(env.FITNESS_W_MERGE, 3) });
/**
 * Prod 03-10 (first 10 shadow decisions, all "workstation"): ~300 gym outcomes × 0.25 outweighed 9 real ones (0/9) — a
 * per-outcome weight cannot stop volume from dominating. The gym is a PRIOR: its total weight is capped at
 * FITNESS_GYM_MAX_WEIGHT pseudo-observations (default 5), keeping its success rate but not its count.
 */
export const gymMaxWeight = (env: NodeJS.ProcessEnv = process.env): number => num(env.FITNESS_GYM_MAX_WEIGHT, 5);
export const fitnessShadowEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.FITNESS_SHADOW_ENABLED === 'true';

/** The skill_outcomes keys of one species per source. A remote species `remote@<host>/<rt>@<model>` trains in the gym as `<rt>@<model>`. */
export function fitnessKeys(lane: string, s: Species): Array<{ source: FitnessSource; skillId: string; model: string }> {
  const model = s.model ?? '';
  const remote = s.runtime === 'remote' ? /^[^/]+\/([^@]+)@(.+)$/.exec(model) : null;
  return [
    { source: 'production', skillId: `loop-maker:${lane}:${s.runtime}`, model },
    { source: 'gym', skillId: `loop-maker:gym:${remote ? remote[1] : s.runtime}`, model: remote ? remote[2] : model },
    { source: 'merge', skillId: `loop-maker:merge:${s.runtime}`, model },
  ];
}

/** RX-3: production zeros that are not the species' fault (infra, no change, or an eligible maker that lost evolve on rank). */
export const UNFAIR_ZERO = /"(outcome_class:(infra_failed|no_change)|evolve:lost_eligible)"/;
export interface FitnessRow { species: string; sources: Record<FitnessSource, { n: number; ok: number }>; alpha: number; beta: number; mean: number; tagged: number; mean_clean: number }

export function fitnessPosterior(db: Database, lane: string, species: Species[], now = Date.now(), env: NodeJS.ProcessEnv = process.env): FitnessRow[] {
  const w = fitnessWeights(env); const halfLifeMs = num(env.FITNESS_HALF_LIFE_DAYS, 30) * 86_400_000;
  const rows = (skillId: string, model: string): Array<{ success: number; created_at: string; refs: string | null }> => {
    try { return db.prepare('SELECT success, created_at, evidence_refs_json AS refs FROM skill_outcomes WHERE skill_id = ? AND COALESCE(model, \'\') = ?').all(skillId, model) as Array<{ success: number; created_at: string; refs: string | null }>; }
    catch { return []; } // skill_outcomes is created lazily
  };
  return species.map((s) => {
    let alpha = 1; let beta = 1; let cleanAlpha = 1; let cleanBeta = 1; let tagged = 0;
    const sources = { production: { n: 0, ok: 0 }, gym: { n: 0, ok: 0 }, merge: { n: 0, ok: 0 } };
    for (const k of fitnessKeys(lane, s)) {
      let a = 0; let b = 0; let unfair = 0;
      for (const r of rows(k.skillId, k.model)) {
        const age = Math.max(0, now - Date.parse(r.created_at));
        const weight = w[k.source] * (halfLifeMs > 0 ? 0.5 ** (age / halfLifeMs) : 1);
        if (r.success) a += weight; else b += weight;
        if (k.source === 'production' && !r.success && UNFAIR_ZERO.test(r.refs ?? '')) { unfair += weight; tagged++; }
        sources[k.source].n++; sources[k.source].ok += r.success ? 1 : 0;
      }
      const scale = k.source === 'gym' && a + b > gymMaxWeight(env) ? gymMaxWeight(env) / (a + b) : 1;
      alpha += a * scale; beta += b * scale;
      cleanAlpha += a * scale; cleanBeta += (b - unfair) * scale;
    }
    return { species: speciesKey(s), sources, alpha: +alpha.toFixed(3), beta: +beta.toFixed(3), mean: +(alpha / (alpha + beta)).toFixed(3),
      tagged, mean_clean: +(cleanAlpha / (cleanAlpha + cleanBeta)).toFixed(3) };
  });
}

/** Shadow: the species the weighted posterior would pick (highest mean) next to the bandit's real choice, with the full table. */
export function recordFitnessShadow(db: Database, runId: string, lane: string, species: Species[], actual: string | null, now = Date.now()): void {
  if (!fitnessShadowEnabled() || species.length < 2) return;
  const table = fitnessPosterior(db, lane, species, now);
  const pick = table.reduce((b, r) => (r.mean > b.mean ? r : b), table[0]).species;
  new LoopEventService(db).recordEvent(runId, 'fitness_shadow', 'info', `Fitness view would pick ${pick}; bandit chose ${actual ?? 'none'}${pick === actual ? ' (agree)' : ''}`,
    { lane, would_pick: pick, actual, agree: pick === actual, weights: fitnessWeights(), table });
}
