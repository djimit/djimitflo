import type { Database } from 'better-sqlite3';
import type { GymTask } from './gym-task-miner';

/**
 * Y3 (plan Phase Y, Darwin loop): the population of maker strategy genomes and the frozen gym holdout they are judged on.
 * A genome here is the evolvable part of a maker assignment: extra strategy lines (Y2 records the rest per run). The baseline
 * has none. Mutants (from the nightly dream job) run as 'trial' on the holdout next to the baseline — the same tasks, so the
 * comparison is paired — and only a clear holdout win makes one 'active'. Behind DREAM_EVOLUTION_ENABLED (default off).
 */
export interface Genome { id: string; parent_id: string | null; gene: string; lines: string[]; origin: string; status: string }
export const BASELINE_GENOME = 'baseline';
export const HOLDOUT_SIZE = 20;
export const dreamEvolutionEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.DREAM_EVOLUTION_ENABLED === 'true';

export function ensureBaseline(db: Database, now = new Date().toISOString()): void {
  db.prepare(`INSERT OR IGNORE INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, note, created_at, updated_at)
    VALUES (?, NULL, 'baseline', '[]', 'baseline', 'active', 'today''s assignment without extra strategy lines', ?, ?)`).run(BASELINE_GENOME, now, now);
}

export function genome(db: Database, id: string): Genome | null {
  const row = db.prepare('SELECT id, parent_id, gene, lines_json, origin, status FROM maker_genomes WHERE id = ?').get(id) as
    { id: string; parent_id: string | null; gene: string; lines_json: string; origin: string; status: string } | undefined;
  if (!row) return null;
  let lines: string[] = [];
  try { lines = (JSON.parse(row.lines_json) as unknown[]).filter((l): l is string => typeof l === 'string'); } catch { /* malformed: no lines */ }
  return { id: row.id, parent_id: row.parent_id, gene: row.gene, lines, origin: row.origin, status: row.status };
}

/** Picks the holdout once — every k-th mined task, deterministic — and never changes it afterwards. */
export function holdout(db: Database, tasks: GymTask[], now = new Date().toISOString()): string[] {
  const frozen = (db.prepare('SELECT commit_sha FROM gym_holdout ORDER BY commit_sha').all() as Array<{ commit_sha: string }>).map((r) => r.commit_sha);
  if (frozen.length || tasks.length < HOLDOUT_SIZE) return frozen;
  const sorted = [...tasks].sort((a, b) => a.commit.localeCompare(b.commit));
  const step = sorted.length / HOLDOUT_SIZE;
  const insert = db.prepare('INSERT OR IGNORE INTO gym_holdout (commit_sha, created_at) VALUES (?, ?)');
  for (let i = 0; i < HOLDOUT_SIZE; i++) insert.run(sorted[Math.floor(i * step)].commit, now);
  return holdout(db, [], now);
}

/**
 * The next paired trial attempt for a species: each trial genome and its parent need one non-infra attempt on every
 * holdout task. Parents first per task, so a comparison is never waiting on the parent.
 */
export function nextTrialAttempt(db: Database, speciesKey: string, holdoutCommits: string[]): { genomeId: string; commit: string } | null {
  const trials = db.prepare("SELECT id, COALESCE(parent_id, ?) AS parent FROM maker_genomes WHERE status = 'trial' ORDER BY created_at").all(BASELINE_GENOME) as Array<{ id: string; parent: string }>;
  if (!trials.length || !holdoutCommits.length) return null;
  const done = db.prepare(`SELECT 1 FROM loop_runs WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym.species') = ?
    AND json_extract(metadata, '$.gym.genome') = ? AND json_extract(metadata, '$.gym.commit') = ?
    AND (status = 'running' OR COALESCE(json_extract(metadata, '$.gym_result.reason'), '') NOT LIKE 'infra:%') LIMIT 1`);
  for (const trial of trials) {
    for (const commit of holdoutCommits) {
      for (const genomeId of [trial.parent, trial.id]) if (!done.get(speciesKey, genomeId, commit)) return { genomeId, commit };
    }
  }
  return null;
}
