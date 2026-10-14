import type { Database } from 'better-sqlite3';
import type { GymTask } from './gym-task-miner';
import type { MutantTask } from './gym-mutants';
import type { FailureTask } from './gym-failure-tasks';
import { fitIrt, gymObservations, irtSelectionEnabled, pickInformativeItems, respondentKey } from './gym-irt';
import { DEFAULT_HOLDOUT_SIZE, exclusionReason, holdoutExclusions, resolveHoldoutSize } from './holdout-exposure';

/**
 * Y3 (plan Phase Y, Darwin loop): the population of maker strategy genomes and the frozen gym holdout they are judged on.
 * A genome here is the evolvable part of a maker assignment: extra strategy lines (Y2 records the rest per run). The baseline
 * has none. Mutants (from the nightly dream job) run as 'trial' on the holdout next to the baseline — the same tasks, so the
 * comparison is paired — and only a clear holdout win makes one 'active'. Behind DREAM_EVOLUTION_ENABLED (default off).
 */
export interface Genome { id: string; parent_id: string | null; gene: string; lines: string[]; origin: string; status: string }
export const BASELINE_GENOME = 'baseline';
export const HOLDOUT_SIZE = DEFAULT_HOLDOUT_SIZE;
/**
 * Holdout epoch 1 (14-10): calibration rows (role 'calibration', only from a manifest freeze) are frozen and never deciding:
 * every reader of a deciding set below filters them out. An epoch frozen from a manifest (gym_holdout_freezes) never grows
 * at claim time. The claim-time size is HOLDOUT_SIZE (validated; invalid or too few eligible tasks freeze nothing).
 */
const DECIDING = "COALESCE(role, 'deciding') = 'deciding'";
const manifestFrozen = (db: Database, epoch: number): boolean => {
  try { return Boolean(db.prepare('SELECT 1 FROM gym_holdout_freezes WHERE epoch = ?').get(epoch)); } catch { return false; }
};
// claim time: frozen / TG-001 / dream-exposed (tasks, source files, derived). Trial-attempted is checked by the manifest
// freeze only: trials run only on frozen tasks, so outside a manifest it adds nothing a frozen key does not already exclude.
const claimExclusions = (db: Database) => ({ ...holdoutExclusions(db), trialAttempted: new Set<string>() });
const claimSize = (table: string): number | null => {
  const s = resolveHoldoutSize();
  if (s.ok) return s.size;
  console.warn(`🧬 ${table}: HOLD — ${s.reason}; nothing frozen`); return null;
};
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

/**
 * RX-12 (Phase F): holdouts come in epochs. GYM_HOLDOUT_EPOCH (default 0 = the holdout frozen since 01-10) selects one; a new
 * epoch freezes fresh tasks next to the old ones (never reusing a task of another epoch; nothing is deleted). A holdout is
 * consumable — every settled trial looks at it — so rotating gives later trials untouched tasks. Rotation is refused while a
 * genome is in trial: the epoch it started on stays until it settles.
 */
export const requestedHoldoutEpoch = (env: NodeJS.ProcessEnv = process.env): number => {
  const n = Number(env.GYM_HOLDOUT_EPOCH); return Number.isInteger(n) && n >= 0 ? n : 0;
};
const warned = new Set<string>();
export function holdoutEpoch(db: Database, table: 'gym_holdout' | 'gym_mutant_holdout' | 'gym_write_test_holdout', env: NodeJS.ProcessEnv = process.env): number {
  const want = requestedHoldoutEpoch(env);
  let epochs: number[] = [];
  try { epochs = (db.prepare(`SELECT DISTINCT epoch FROM ${table}`).all() as Array<{ epoch: number }>).map((r) => r.epoch); } catch { return want; }
  if (!epochs.length || epochs.includes(want) || !db.prepare("SELECT 1 FROM maker_genomes WHERE status = 'trial' LIMIT 1").get()) return want;
  const current = Math.max(...epochs);
  const key = `${table}:${want}`;
  if (!warned.has(key)) { warned.add(key); console.warn(`🧬 ${table}: GYM_HOLDOUT_EPOCH=${want} waits — a genome is in trial on epoch ${current}`); }
  return current;
}
export function frozenHoldoutCommits(db: Database): string[] {
  return (db.prepare(`SELECT commit_sha FROM gym_holdout WHERE epoch = ? AND ${DECIDING} ORDER BY commit_sha`).all(holdoutEpoch(db, 'gym_holdout')) as Array<{ commit_sha: string }>).map((r) => r.commit_sha);
}

/** Picks the holdout of the current epoch once — every k-th eligible mined task (holdoutExclusions), deterministic — and never changes it. */
export function holdout(db: Database, tasks: GymTask[], now = new Date().toISOString()): string[] {
  const epoch = holdoutEpoch(db, 'gym_holdout');
  const frozen = (db.prepare(`SELECT commit_sha FROM gym_holdout WHERE epoch = ? AND ${DECIDING} ORDER BY commit_sha`).all(epoch) as Array<{ commit_sha: string }>).map((r) => r.commit_sha);
  if (frozen.length || !tasks.length || manifestFrozen(db, epoch)) return frozen;
  const size = claimSize('gym_holdout'); if (size === null) return frozen;
  const ex = claimExclusions(db);
  const fresh = tasks.filter((t) => !exclusionReason(ex, { commit: t.commit, source: t.source }));
  if (fresh.length < size) return frozen;
  const sorted = [...fresh].sort((a, b) => a.commit.localeCompare(b.commit));
  const step = sorted.length / size;
  const insert = db.prepare('INSERT OR IGNORE INTO gym_holdout (commit_sha, created_at, epoch) VALUES (?, ?, ?)');
  // B8: with GYM_IRT_SELECTION the new epoch prefers the fresh tasks with the most information at the parent's ability;
  // the rest is filled with the deterministic spread below (off: exactly the spread, as before)
  const picked: string[] = [];
  if (irtSelectionEnabled()) {
    const fit = fitIrt(gymObservations(db));
    const theta = fit.abilities[respondentKey(process.env.DREAM_EVOLUTION_SPECIES || 'atomic@llama-router')] ?? 0;
    const freshKeys = new Set(fresh.map((t) => t.commit));
    picked.push(...pickInformativeItems(fit.items.filter((it) => freshKeys.has(it.key)), theta, size).map((it) => it.key));
  }
  for (let i = 0; picked.length < size && i < sorted.length; i++) {
    const c = sorted[Math.floor(i * step) % sorted.length].commit;
    if (!picked.includes(c)) picked.push(c);
  }
  db.transaction(() => { for (const c of picked.slice(0, size)) insert.run(c, now, epoch); })();
  return holdout(db, [], now);
}

/**
 * Z5 (operator go 02-10): on the mined holdout every genome solved the same 15 of 20 tasks (4/4 mutants tied or lost) — it
 * measured task difficulty, not strategy. With DREAM_TRIAL_MUTANTS trials are judged on 20 seeded mutant-repair tasks at
 * tier 2–3 instead, frozen once with their base and mutant (a deploy changes the checkout); the mined holdout stays as a
 * no-regression check.
 */
export const mutantTrialsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.DREAM_TRIAL_MUTANTS === 'true';
// prod 2026-10-03: tier 2–3 mutants still ≈ 90 % for atomic (target 30–70 %) → DREAM_TRIAL_MUTANT_TIERS picks the tier set; a new
// set freezes its own 20 tasks next to the old ones (nothing deleted). Change it only between trials.
export const mutantHoldoutTiers = (env: NodeJS.ProcessEnv = process.env): number[] => {
  const tiers = (env.DREAM_TRIAL_MUTANT_TIERS || '2,3').split(',').map(Number).filter((t) => Number.isInteger(t) && t >= 1 && t <= 8);
  return tiers.length ? tiers : [2, 3];
};
export function mutantHoldoutKeys(db: Database, tiers = mutantHoldoutTiers()): string[] {
  return (db.prepare(`SELECT key, task_json FROM gym_mutant_holdout WHERE epoch = ? AND ${DECIDING} ORDER BY key`).all(holdoutEpoch(db, 'gym_mutant_holdout')) as Array<{ key: string; task_json: string }>)
    .filter((r) => tiers.includes(Number((JSON.parse(r.task_json) as MutantTask).tier))).map((r) => r.key);
}
export function mutantHoldout(db: Database, make: (tier: number, tried: Set<string | null>) => MutantTask | null, now = new Date().toISOString(), tiers = mutantHoldoutTiers()): MutantTask[] {
  const epoch = holdoutEpoch(db, 'gym_mutant_holdout');
  const read = () => (db.prepare(`SELECT task_json FROM gym_mutant_holdout WHERE epoch = ? AND ${DECIDING} ORDER BY key`).all(epoch) as Array<{ task_json: string }>)
    .map((r) => JSON.parse(r.task_json) as MutantTask).filter((t) => tiers.includes(Number(t.tier)));
  const frozen = read();
  if (frozen.length || manifestFrozen(db, epoch)) return frozen;
  const size = claimSize('gym_mutant_holdout'); if (size === null) return frozen;
  // RX-12: a new epoch never reuses a task frozen by another one; epoch 1: nor a mutant on a dream-exposed source file
  const ex = claimExclusions(db);
  const picked = generateMutants(ex, make, tiers, size);
  if (picked.length < size) { console.warn(`🧬 gym_mutant_holdout: HOLD — ${picked.length} of ${size} eligible mutants; nothing frozen`); return frozen; }
  const insert = db.prepare('INSERT OR IGNORE INTO gym_mutant_holdout (key, task_json, created_at, epoch) VALUES (?, ?, ?, ?)');
  db.transaction(() => { for (const task of picked) insert.run(task.commit, JSON.stringify(task), now, epoch); })();
  return read();
}
/**
 * Up to `size` eligible mutants, tiers round-robin; an excluded one is marked tried and the generator asked again (bounded).
 * mutantTask picks the file from the seed alone, so without a cap the same file comes back at every tier (epoch-1 dry run
 * 14-10: 40 mutants on 10 files, design effect 1.3). `maxPerSource` caps mutants per source file (manifest
 * tasks.mutant.max_per_source); the claim-time freeze keeps no cap (unchanged).
 */
export function generateMutants(ex: ReturnType<typeof holdoutExclusions>, make: (tier: number, tried: Set<string | null>) => MutantTask | null, tiers: number[], size: number,
  maxPerSource = Infinity): MutantTask[] {
  const tried = new Set<string | null>(ex.frozen); const picked: MutantTask[] = []; const perSource = new Map<string, number>();
  for (let attempts = 0; picked.length < size && attempts < size * 100; attempts++) {
    const task = make(tiers[picked.length % tiers.length], tried);
    if (!task) break;
    if (tried.has(task.commit)) continue;
    tried.add(task.commit);
    if (exclusionReason(ex, task) || (perSource.get(task.source) ?? 0) >= maxPerSource) continue;
    picked.push(task); perSource.set(task.source, (perSource.get(task.source) ?? 0) + 1);
  }
  return picked;
}

/**
 * WT-HOLDOUT (09-10): the mined and mutant holdouts are REPAIR tasks — their graded score is 0/1 by nature (prod: graded mean
 * of the parent 0.85 = its binary pass rate), so graded trials gain no power on them. A failure-derived write_test task is
 * graded as the share of seeded target mutants its test kills (mutant_kill), which keeps moving where pass/fail saturates.
 * With DREAM_TRIAL_WRITE_TEST_HOLDOUT (default off) up to 20 of them are frozen per epoch (same pattern as the mutant holdout:
 * the whole task with base, target and mutants is stored; a new epoch never reuses a task), served only in trials, after the
 * existing phases and only to a worker announcing 'write_test'; dreamInputs never sees them. Fewer than
 * WRITE_TEST_HOLDOUT_MIN available tasks freeze nothing (a tiny holdout would lock the epoch); the next claim tries again.
 */
export const writeTestHoldoutEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.DREAM_TRIAL_WRITE_TEST_HOLDOUT === 'true';
export const WRITE_TEST_HOLDOUT_MIN = 5;
export function writeTestHoldoutKeys(db: Database): string[] {
  return (db.prepare(`SELECT key FROM gym_write_test_holdout WHERE epoch = ? AND ${DECIDING} ORDER BY key`).all(holdoutEpoch(db, 'gym_write_test_holdout')) as Array<{ key: string }>).map((r) => r.key);
}
export function writeTestHoldout(db: Database, make: () => FailureTask[], now = new Date().toISOString()): FailureTask[] {
  const epoch = holdoutEpoch(db, 'gym_write_test_holdout');
  const read = () => (db.prepare(`SELECT task_json FROM gym_write_test_holdout WHERE epoch = ? AND ${DECIDING} ORDER BY key`).all(epoch) as Array<{ task_json: string }>)
    .map((r) => JSON.parse(r.task_json) as FailureTask);
  const frozen = read();
  if (frozen.length || manifestFrozen(db, epoch)) return frozen;
  const size = claimSize('gym_write_test_holdout'); if (size === null) return frozen;
  // other epochs' tasks, TG-001 tasks (diagnostic: prior exposure, four prompts each) and anything dream-exposed or derived
  // from it (target/test file, base commit, failing run) never enter a promotion holdout
  const ex = claimExclusions(db);
  const fresh = make().filter((t) => !exclusionReason(ex, t)).sort((a, b) => a.commit.localeCompare(b.commit)).slice(0, size);
  if (fresh.length < WRITE_TEST_HOLDOUT_MIN) return [];
  const insert = db.prepare('INSERT OR IGNORE INTO gym_write_test_holdout (key, task_json, created_at, epoch) VALUES (?, ?, ?, ?)');
  db.transaction(() => { for (const t of fresh) insert.run(t.commit, JSON.stringify(t), now, epoch); })();
  return read();
}

/**
 * The next paired trial attempt for a species: each trial genome and its parent need one non-infra attempt on every
 * holdout task. Parents first per task, so a comparison is never waiting on the parent.
 */
/** B8: TRIAL_HEADROOM_PRECHECK (default off) — score the parent first and skip trials no mutant could win (dream-evolution). */
export const trialHeadroomPrecheck = (env: NodeJS.ProcessEnv = process.env): boolean => env.TRIAL_HEADROOM_PRECHECK === 'true';
export function nextTrialAttempt(db: Database, speciesKey: string, holdoutCommits: string[]): { genomeId: string; commit: string } | null {
  const trials = db.prepare("SELECT id, COALESCE(parent_id, ?) AS parent FROM maker_genomes WHERE status = 'trial' ORDER BY created_at").all(BASELINE_GENOME) as Array<{ id: string; parent: string }>;
  if (!trials.length || !holdoutCommits.length) return null;
  const attempts = db.prepare(`SELECT COALESCE(SUM(status = 'running'), 0) AS running,
      COALESCE(SUM(status <> 'running' AND ${SCORED}), 0) AS scored,
      COALESCE(SUM(status <> 'running' AND ${SCORED} AND ${ELIGIBLE_GATED}), 0) AS eligible
    FROM loop_runs WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym.species') = ?
    AND json_extract(metadata, '$.gym.genome') = ? AND json_extract(metadata, '$.gym.commit') = ?`);
  // P0 (13-10): with GYM_PROD_GATES on only an eligible gated result settles a task — an ungated one is served again (at most
  // INFRA_GIVE_UP scored attempts in all, so a worker without the prod_gates capability cannot loop on it); off: unchanged.
  // A claimed (running) attempt counts as done, so a second claim never serves the same retry; better-sqlite3 runs claim()
  // synchronously on one connection, so check-then-insert in claim() cannot interleave.
  const gates = gymProdGatesOn();
  const done = { get: (species: string, genomeId: string, commit: string): boolean => {
    const a = attempts.get(species, genomeId, commit) as { running: number; scored: number; eligible: number };
    return a.running > 0 || (gates ? a.eligible > 0 || a.scored >= INFRA_GIVE_UP : a.scored > 0);
  } };
  // B8: with the precheck on, the parent's whole holdout comes first, so headroom is known before any mutant attempt is spent
  if (trialHeadroomPrecheck()) {
    for (const trial of trials) for (const commit of holdoutCommits) if (!done.get(speciesKey, trial.parent, commit) && !unscorable(db, speciesKey, trial.parent, commit)) return { genomeId: trial.parent, commit };
  }
  for (const trial of trials) {
    for (const commit of holdoutCommits) {
      for (const genomeId of [trial.parent, trial.id]) if (!done.get(speciesKey, genomeId, commit) && !unscorable(db, speciesKey, genomeId, commit)) return { genomeId, commit };
    }
  }
  return null;
}

/**
 * A holdout task that keeps timing out for a genome is unscorable, not pending (prod 2026-10-01/02: 9b2fa2bf timed out 6 of
 * 10 times; served again after every bench, it benched the only gym species for 2 h at a time and no trial could complete).
 * After INFRA_GIVE_UP infra discards (or VOID attempts, see GENOME_FIRE_CHECK) the pair is skipped and left out of the
 * paired comparison on both sides.
 */
export const INFRA_GIVE_UP = 3;
export function unscorable(db: Database, speciesKey: string, genomeId: string, commit: string): boolean {
  return (db.prepare(`SELECT COUNT(*) AS n FROM loop_runs WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym.species') = ?
    AND json_extract(metadata, '$.gym.genome') = ? AND json_extract(metadata, '$.gym.commit') = ?
    AND (COALESCE(json_extract(metadata, '$.gym_result.reason'), '') LIKE 'infra:%' OR json_extract(metadata, '$.gym_result.status') = 'discarded' OR NOT ${NOT_VOID})`).get(speciesKey, genomeId, commit) as { n: number }).n >= INFRA_GIVE_UP;
}
/** A completed attempt that observed the task: not infra-censored (infra reason or discarded), not VOID. */
const SCORED = `(COALESCE(json_extract(metadata, '$.gym_result.reason'), '') NOT LIKE 'infra:%' AND COALESCE(json_extract(metadata, '$.gym_result.status'), '') <> 'discarded'
  AND json_extract(metadata, '$.gym_result.void') IS NULL)`;

/**
 * Fire check (metaharness lesson: three times their 'treatment' never reached the agent, so treatment = control, silently).
 * With GENOME_FIRE_CHECK (default off) the gym worker reports the sha256 of the goal it actually sent the maker and how many
 * of the genome's strategy lines were found in it. A scored attempt of a non-baseline genome without that evidence, or with
 * fewer lines found than the genome has, is VOID: `gym_result.void` holds why. A VOID attempt is not an attempt — it is
 * served again, never paired (McNemar / e-process), earns no outcome, and after INFRA_GIVE_UP of them the task is unscorable
 * for that pair. Off: nothing is marked, so nothing is excluded.
 */
export const genomeFireCheck = (env: NodeJS.ProcessEnv = process.env): boolean => env.GENOME_FIRE_CHECK === 'true';
export const NOT_VOID = "json_extract(metadata, '$.gym_result.void') IS NULL";
/**
 * P0 (13-10, EVOLUTION ENGINE 4.0): a gym attempt whose verdict holds under the production gates — claimed with them
 * (gym.prod_gates = 1, GYM_PROD_GATES) and the gate verdict recorded on that attempt: a failure (proxy or prod_gate_failed:*),
 * or a success carrying its per-check gym_result.prod_gates map (the worker runs the gates only on a proxy success). A gated
 * success without that map never proved its gates ran. Only such attempts may decide headroom or promotion (dream-evolution).
 */
export const ELIGIBLE_GATED = `(json_extract(metadata, '$.gym.prod_gates') = 1 AND (json_extract(metadata, '$.gym_result.status') = 'failure'
  OR (json_extract(metadata, '$.gym_result.status') = 'success' AND json_type(metadata, '$.gym_result.prod_gates') = 'object')))`;
export const gymProdGatesOn = (env: NodeJS.ProcessEnv = process.env): boolean => env.GYM_PROD_GATES === 'true';
export interface FireCheck { goal_sha256: string; genome_lines: number; genome_lines_found: number }
/** The worker's evidence, sanitised (null when absent or malformed). */
export function parseFireCheck(raw: unknown): FireCheck | null {
  const f = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  if (!f || typeof f.goal_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.goal_sha256)) return null;
  const lines = Number(f.genome_lines); const found = Number(f.genome_lines_found);
  if (!Number.isInteger(lines) || !Number.isInteger(found) || lines < 0 || found < 0 || found > lines) return null;
  return { goal_sha256: f.goal_sha256, genome_lines: lines, genome_lines_found: found };
}
/** Why a scored attempt of `genomeId` is VOID, or null when the treatment provably reached the maker (or there is none). */
export function fireCheckVoid(db: Database, genomeId: string | undefined, status: string, evidence: FireCheck | null): string | null {
  if (!genomeId || genomeId === BASELINE_GENOME || (status !== 'success' && status !== 'failure')) return null;
  const want = Math.max(1, genome(db, genomeId)?.lines.length ?? 0);
  if (!evidence) return 'fire_check: no evidence that the genome lines reached the maker';
  return evidence.genome_lines_found >= want ? null : `fire_check: ${evidence.genome_lines_found} of ${want} genome lines in the maker prompt`;
}

/**
 * D2 (Darwin engine): which strategy genome a production maker runs with. Genomes evolve for one gym species
 * (DREAM_EVOLUTION_SPECIES, default atomic@llama-router); a real maker of that species — directly or as
 * `remote@<host>/<rt>@<model>` — is attributed to the newest active non-baseline genome, else to the baseline. Other
 * species have no strategy genome (null). Attribution only: injecting the lines is a separate, operator-owned step.
 */
export function strategyGenomeFor(db: Database, runtime: string, model: string | null | undefined, env: NodeJS.ProcessEnv = process.env): Genome | null {
  const species = env.DREAM_EVOLUTION_SPECIES || 'atomic@llama-router';
  const remote = runtime === 'remote' ? /^[^/]+\/(.+)$/.exec(model ?? '') : null;
  const key = remote ? remote[1] : model ? `${runtime}@${model}` : runtime;
  if (key !== species) return null;
  const row = db.prepare("SELECT id FROM maker_genomes WHERE status = 'active' AND id <> ? ORDER BY updated_at DESC LIMIT 1").get(BASELINE_GENOME) as { id: string } | undefined;
  return genome(db, row?.id ?? BASELINE_GENOME);
}
