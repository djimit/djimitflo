import type { Database } from 'better-sqlite3';
import { betaSample } from './self-improvement-service';
import type { Species } from './evolve-selection';

/**
 * E12: which maker species (runtime[@model]) does a loop's work — chosen by outcome, not by config. Thompson sampling
 * over each species' verified/failed runs in skill_outcomes (one row per run, #359). The first species is the incumbent;
 * a challenger with fewer than PROMOTE_AFTER outcomes gets at most LOOP_BANDIT_MAX_SHARE of the runs (default 10 %), so
 * a weak newcomer costs little and a strong one earns its way to full traffic.
 *   LOOP_BANDIT_ENABLED=true   LOOP_BANDIT_SPECIES=opencode,opencode@ollama/kimi-k2.6:cloud   (first = incumbent)
 */
export const PROMOTE_AFTER = 20;

export function banditSpecies(env: NodeJS.ProcessEnv = process.env): Species[] {
  if (env.LOOP_BANDIT_ENABLED !== 'true') return [];
  return (env.LOOP_BANDIT_SPECIES || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const at = s.indexOf('@');
    return at < 0 ? { runtime: s } : { runtime: s.slice(0, at), model: s.slice(at + 1) };
  });
}

export const speciesKey = (s: Species) => (s.model ? `${s.runtime}@${s.model}` : s.runtime);

export interface BanditChoice { species: Species; reason: string; posterior: Array<{ species: string; runs: number; ok: number; sample: number }> }

export function chooseSpecies(db: Database, loopName: string, species: Species[], rng: () => number = Math.random,
  maxShare = Number(process.env.LOOP_BANDIT_MAX_SHARE) || 0.1): BanditChoice | null {
  if (species.length < 2) return null;
  let stats: Array<{ runs: number; ok: number }>;
  try {
    const q = db.prepare(`SELECT COUNT(*) AS runs, COALESCE(SUM(success), 0) AS ok FROM skill_outcomes WHERE skill_id = ? AND COALESCE(model, '') = ?`);
    stats = species.map((s) => q.get(`loop-maker:${loopName}:${s.runtime}`, s.model ?? '') as { runs: number; ok: number });
  } catch { return null; } // skill_outcomes is created lazily
  const posterior = species.map((s, i) => ({ species: speciesKey(s), runs: stats[i].runs, ok: stats[i].ok,
    sample: betaSample(1 + stats[i].ok, 1 + stats[i].runs - stats[i].ok, rng) }));
  const best = posterior.reduce((b, p, i) => (p.sample > posterior[b].sample ? i : b), 0);
  if (best === 0) return { species: species[0], reason: 'incumbent sampled best', posterior };
  if (stats[best].runs >= PROMOTE_AFTER) return { species: species[best], reason: `challenger sampled best with ${stats[best].runs} outcomes`, posterior };
  return rng() < maxShare
    ? { species: species[best], reason: `challenger explored (${stats[best].runs} < ${PROMOTE_AFTER} outcomes, share ${maxShare})`, posterior }
    : { species: species[0], reason: 'challenger capped: not enough outcomes yet', posterior };
}
