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

export interface FitnessRow { species: string; sources: Record<FitnessSource, { n: number; ok: number }>; alpha: number; beta: number; mean: number }

export function fitnessPosterior(db: Database, lane: string, species: Species[], now = Date.now(), env: NodeJS.ProcessEnv = process.env): FitnessRow[] {
  const w = fitnessWeights(env); const halfLifeMs = num(env.FITNESS_HALF_LIFE_DAYS, 30) * 86_400_000;
  const rows = (skillId: string, model: string): Array<{ success: number; created_at: string }> => {
    try { return db.prepare('SELECT success, created_at FROM skill_outcomes WHERE skill_id = ? AND COALESCE(model, \'\') = ?').all(skillId, model) as Array<{ success: number; created_at: string }>; }
    catch { return []; } // skill_outcomes is created lazily
  };
  return species.map((s) => {
    let alpha = 1; let beta = 1;
    const sources = { production: { n: 0, ok: 0 }, gym: { n: 0, ok: 0 }, merge: { n: 0, ok: 0 } };
    for (const k of fitnessKeys(lane, s)) {
      for (const r of rows(k.skillId, k.model)) {
        const age = Math.max(0, now - Date.parse(r.created_at));
        const weight = w[k.source] * (halfLifeMs > 0 ? 0.5 ** (age / halfLifeMs) : 1);
        if (r.success) alpha += weight; else beta += weight;
        sources[k.source].n++; sources[k.source].ok += r.success ? 1 : 0;
      }
    }
    return { species: speciesKey(s), sources, alpha: +alpha.toFixed(3), beta: +beta.toFixed(3), mean: +(alpha / (alpha + beta)).toFixed(3) };
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
