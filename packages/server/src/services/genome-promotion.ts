import type { Database } from 'better-sqlite3';
import { BASELINE_GENOME, holdoutEpoch } from './genome-registry';
import { HOLDOUT_REUSE_LIMIT } from './evolution-evidence';

/**
 * Codex directive P0 (11-10): the single boundary where a maker genome becomes 'active'. Every promotion path must call
 * promoteGenome(); a static test keeps every other write of maker_genomes.status off 'active' (only the baseline seed).
 * The deciding holdout epoch must be provably fresh: an exhausted epoch blocks promotion, and so does an epoch whose
 * validity cannot be established (query error, no deciding tasks) — unknown is never treated as valid.
 * holdoutExposure() (evolution-evidence) stays the lenient, read-only display; this check is strict and throws nothing.
 */
export type DecidingHoldout = 'mined' | 'mutant';
export interface HoldoutValidity { state: 'valid' | 'exhausted' | 'unknown'; holdout: DecidingHoldout; epoch: number | null; candidates: number | null; limit: number; reason: string }

export const holdoutReuseLimit = (env: NodeJS.ProcessEnv = process.env): number =>
  Number(env.DREAM_HOLDOUT_REUSE_LIMIT) > 0 ? Number(env.DREAM_HOLDOUT_REUSE_LIMIT) : HOLDOUT_REUSE_LIMIT;

const TABLES = { mined: 'gym_holdout', mutant: 'gym_mutant_holdout' } as const;

export function holdoutValidity(db: Database, holdout: DecidingHoldout, decidingKeys: string[], env: NodeJS.ProcessEnv = process.env): HoldoutValidity {
  const limit = holdoutReuseLimit(env);
  let epoch: number | null = null;
  try {
    epoch = holdoutEpoch(db, TABLES[holdout], env);
    if (!decidingKeys.length) return { state: 'unknown', holdout, epoch, candidates: null, limit, reason: `holdout_validity_unknown: ${holdout} epoch ${epoch} has no deciding tasks` };
    // same population as holdoutExposure, on the exact tasks that decide: distinct non-baseline genomes that ran on them,
    // plus the trials already decided on this epoch
    const ran = (db.prepare(`SELECT DISTINCT json_extract(metadata, '$.gym.genome') AS g FROM loop_runs WHERE loop_name = 'evolution-gym' AND status = 'completed'
      AND json_extract(metadata, '$.gym.canary') IS NULL AND json_extract(metadata, '$.gym.commit') IN (SELECT value FROM json_each(?))`).all(JSON.stringify(decidingKeys)) as Array<{ g: string | null }>).map((r) => r.g);
    const decided = (db.prepare(`SELECT trial_id AS g FROM genome_trial_results WHERE COALESCE(epoch, 0) = ? AND tier_set IS NOT NULL AND (tier_set = 'mined') = ?`)
      .all(epoch, holdout === 'mined' ? 1 : 0) as Array<{ g: string }>).map((r) => r.g);
    const candidates = new Set([...ran, ...decided].filter((g): g is string => Boolean(g) && g !== BASELINE_GENOME)).size;
    if (candidates > limit) return { state: 'exhausted', holdout, epoch, candidates, limit, reason: `holdout_exhausted: ${holdout} epoch ${epoch} used by ${candidates} candidates (limit ${limit})` };
    return { state: 'valid', holdout, epoch, candidates, limit, reason: `holdout ${holdout} epoch ${epoch}: ${candidates} candidates (limit ${limit})` };
  } catch (e) {
    return { state: 'unknown', holdout, epoch, candidates: null, limit, reason: `holdout_validity_unknown: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
  }
}

/**
 * The only way a genome becomes 'active'. Re-checks the deciding holdout at the moment of promotion; a refused promotion
 * leaves the genome 'inconclusive' (never 'retired': a spent or unknown holdout is evidence of nothing) with the reason.
 */
export function promoteGenome(db: Database, id: string, holdout: DecidingHoldout, decidingKeys: string[], note: string, iso: string, env: NodeJS.ProcessEnv = process.env): { promoted: boolean; validity: HoldoutValidity } {
  const validity = holdoutValidity(db, holdout, decidingKeys, env);
  if (validity.state !== 'valid') {
    db.prepare("UPDATE maker_genomes SET status = 'inconclusive', note = ?, updated_at = ? WHERE id = ? AND status = 'trial'").run(validity.reason, iso, id);
    return { promoted: false, validity };
  }
  db.prepare("UPDATE maker_genomes SET status = 'active', note = ?, updated_at = ? WHERE id = ? AND status = 'trial'").run(note, iso, id);
  return { promoted: true, validity };
}
