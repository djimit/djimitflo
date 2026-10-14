import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { GymTask } from './gym-task-miner';
import type { MutantTask } from './gym-mutants';
import type { FailureTask } from './gym-failure-tasks';
import { exclusionReason, holdoutExclusions, resolveHoldoutSize } from './holdout-exposure';
import { generateMutants, WRITE_TEST_HOLDOUT_MIN } from './genome-registry';

/**
 * Holdout epoch 1 (14-10): an operator-prepared manifest is the only way to freeze an epoch without a remote gym claim — and
 * so without DREAM_EVOLUTION_ENABLED (which also restarts dreaming). freezeHoldoutFromManifest():
 *  1. validates the schema (manifest_version 1) and that the manifest's epoch is the one asked for;
 *  2. verifies sha256 over the canonical manifest (JSON.stringify without manifest_sha256, key order as written) against
 *     both the embedded manifest_sha256 and the operator's expected value;
 *  3. resolves the size (HOLDOUT_SIZE env or the manifest's holdout_size; bounded; a conflict is refused);
 *  4. checks every task eligible NOW: in the eligible pool (same source), not frozen in any epoch, not TG-001, not
 *     trial-attempted, not dream-exposed, its source/target not exposed, not derived from an exposed commit or run
 *     (holdout-exposure). Any violation refuses the whole manifest with the full list;
 *  5. refuses an epoch that already has rows in any holdout table (frozen holdouts never change);
 *  6. fewer deciding tasks than the size (or a mutant generator that runs dry) is HOLD — never a smaller freeze;
 *  7. writes the epoch in ONE transaction with provenance (gym_holdout_freezes: manifest sha, freeze ts, origin sha,
 *     version, counts); `onFrozen` (the audit event) runs inside it, so a failed audit freezes nothing.
 * Calibration tasks (manifest.calibration) are frozen with role 'calibration' and never count as deciding evidence. It reads
 * no flag, starts no scheduler and writes no genome. Promotion thresholds are untouched.
 */
export interface ManifestTask { key: string; source: string }
export interface HoldoutManifest {
  manifest_version: 1; holdout_epoch: number; provenance?: Record<string, unknown>;
  evaluation_policy?: { holdout_size?: number } & Record<string, unknown>; holdout_size?: number;
  tasks: { mined: ManifestTask[]; write_test?: ManifestTask[]; mutant?: { generated_at_freeze: boolean; proposed_tiers: number[]; max_per_source?: number } & Record<string, unknown> } & Record<string, unknown>;
  calibration?: { mined?: string[]; write_test?: string[] };
  manifest_sha256: string;
}
export interface FreezeOptions {
  epoch: number; expectedSha256: string;
  pool: { mined: GymTask[]; writeTest?: FailureTask[] };
  makeMutant?: (tier: number, tried: Set<string | null>) => MutantTask | null;
  origin: { sha: string | null; version: string | null };
  now?: string; env?: NodeJS.ProcessEnv; dryRun?: boolean; operator?: string;
  onFrozen?: (record: FreezeRecord) => void;
}
export interface FreezeRecord {
  epoch: number; manifest_sha256: string; frozen_at: string; origin_sha: string | null; version: string | null; holdout_size: number; operator: string | null;
  counts: { mined: number; mutant: number; write_test: number; calibration: number };
  keys: { mined: string[]; mutant: string[]; write_test: string[]; calibration: string[] };
}
export type FreezeResult =
  | ({ status: 'FROZEN' | 'VALID_DRY_RUN' } & FreezeRecord)
  | { status: 'REFUSED'; violations: string[] }
  | { status: 'HOLD'; reasons: string[] };

export function canonicalManifestJson(manifest: Record<string, unknown>): string {
  const { manifest_sha256: _sha, ...rest } = manifest;
  return JSON.stringify(rest);
}
export const manifestSha256 = (manifest: Record<string, unknown>): string => createHash('sha256').update(canonicalManifestJson(manifest)).digest('hex');

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTasks = (v: unknown): v is ManifestTask[] => Array.isArray(v) && v.every((t) => isObj(t) && typeof t.key === 'string' && t.key.length > 0 && typeof t.source === 'string');
const isKeys = (v: unknown): v is string[] => Array.isArray(v) && v.every((k) => typeof k === 'string');

export function validateManifestSchema(m: unknown): string[] {
  if (!isObj(m)) return ['manifest is not a JSON object'];
  const errors: string[] = [];
  if (m.manifest_version !== 1) errors.push('manifest_version must be 1');
  if (!Number.isInteger(m.holdout_epoch) || (m.holdout_epoch as number) < 0) errors.push('holdout_epoch must be a non-negative integer');
  if (typeof m.manifest_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.manifest_sha256)) errors.push('manifest_sha256 must be 64 lowercase hex characters');
  if (!isObj(m.tasks)) return [...errors, 'tasks must be an object'];
  if (!isTasks(m.tasks.mined)) errors.push('tasks.mined must be a list of {key, source}');
  if (m.tasks.write_test !== undefined && !isTasks(m.tasks.write_test)) errors.push('tasks.write_test must be a list of {key, source}');
  const mutant = m.tasks.mutant;
  if (mutant !== undefined && (!isObj(mutant) || mutant.generated_at_freeze !== true || !Array.isArray(mutant.proposed_tiers) || !mutant.proposed_tiers.length
    || !mutant.proposed_tiers.every((t) => Number.isInteger(t) && t >= 1 && t <= 8)
    || (mutant.max_per_source !== undefined && (!Number.isInteger(mutant.max_per_source) || (mutant.max_per_source as number) < 1)))) errors.push('tasks.mutant must be {generated_at_freeze: true, proposed_tiers: [1..8], max_per_source?: integer >= 1}');
  if (m.calibration !== undefined && (!isObj(m.calibration) || (m.calibration.mined !== undefined && !isKeys(m.calibration.mined))
    || (m.calibration.write_test !== undefined && !isKeys(m.calibration.write_test)))) errors.push('calibration must be {mined?: string[], write_test?: string[]}');
  const policy = isObj(m.evaluation_policy) ? m.evaluation_policy : {};
  if (policy.deciding !== undefined && policy.deciding !== 'mutant' && policy.deciding !== 'mined') errors.push("evaluation_policy.deciding must be 'mutant' or 'mined'");
  if (policy.deciding === 'mutant' && mutant === undefined) errors.push("evaluation_policy.deciding is 'mutant' but tasks.mutant is missing");
  const all = [...(isTasks(m.tasks.mined) ? m.tasks.mined : []), ...(isTasks(m.tasks.write_test) ? m.tasks.write_test : [])].map((t) => t.key);
  const dup = all.filter((k, i) => all.indexOf(k) !== i);
  if (dup.length) errors.push(`duplicate task keys: ${[...new Set(dup)].join(', ')}`);
  return errors;
}

const TABLES = [['gym_holdout', 'commit_sha'], ['gym_mutant_holdout', 'key'], ['gym_write_test_holdout', 'key']] as const;

export function freezeHoldoutFromManifest(db: Database, input: unknown, opts: FreezeOptions): FreezeResult {
  const schemaErrors = validateManifestSchema(input);
  if (schemaErrors.length) return { status: 'REFUSED', violations: schemaErrors };
  const m = input as unknown as HoldoutManifest;
  const violations: string[] = [];
  if (m.holdout_epoch !== opts.epoch) violations.push(`manifest holdout_epoch ${m.holdout_epoch} is not the requested epoch ${opts.epoch}`);
  const sha = manifestSha256(input as Record<string, unknown>);
  if (sha !== m.manifest_sha256) violations.push(`sha256 mismatch: canonical manifest hashes to ${sha}, manifest says ${m.manifest_sha256}`);
  if (sha !== opts.expectedSha256) violations.push(`expected sha256 ${opts.expectedSha256}, manifest hashes to ${sha}`);
  const sizeR = resolveHoldoutSize(opts.env ?? process.env, m.holdout_size ?? m.evaluation_policy?.holdout_size);
  if (!sizeR.ok) violations.push(sizeR.reason);
  const occupied = TABLES.filter(([t]) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE epoch = ?`).get(opts.epoch) as { n: number }).n > 0).map(([t]) => t);
  let recorded = false;
  try { recorded = Boolean(db.prepare('SELECT 1 FROM gym_holdout_freezes WHERE epoch = ?').get(opts.epoch)); } catch { /* table not migrated yet (read-only dry run) */ }
  const occupiedList: string[] = [...occupied, ...(recorded ? ['gym_holdout_freezes'] : [])];
  if (occupiedList.length) violations.push(`epoch ${opts.epoch} already has frozen rows (${occupiedList.join(', ')}); frozen holdouts never change`);
  if (violations.length || !sizeR.ok) return { status: 'REFUSED', violations };
  const size = sizeR.size;

  // every task must be eligible NOW
  const ex = holdoutExclusions(db);
  const minedPool = new Map(opts.pool.mined.map((t) => [t.commit, t]));
  const wtPool = new Map((opts.pool.writeTest ?? []).map((t) => [t.commit, t]));
  const check = (kind: string, t: ManifestTask, pool: Map<string, GymTask | FailureTask>) => {
    const p = pool.get(t.key);
    if (!p) { violations.push(`${kind} ${t.key}: not in the eligible pool`); return; }
    if (p.source !== t.source) violations.push(`${kind} ${t.key}: manifest source ${t.source} differs from the pool's ${p.source}`);
    const why = exclusionReason(ex, p);
    if (why) violations.push(`${kind} ${t.key}: ${why}`);
  };
  for (const t of m.tasks.mined) check('mined', t, minedPool);
  for (const t of m.tasks.write_test ?? []) check('write_test', t, wtPool);
  const calMined = new Set(m.calibration?.mined ?? []); const calWt = new Set(m.calibration?.write_test ?? []);
  for (const k of calMined) if (!m.tasks.mined.some((t) => t.key === k)) violations.push(`calibration mined ${k}: not a manifest mined task`);
  for (const k of calWt) if (!(m.tasks.write_test ?? []).some((t) => t.key === k)) violations.push(`calibration write_test ${k}: not a manifest write_test task`);
  if (m.tasks.mutant && !opts.makeMutant) violations.push('tasks.mutant is generated at freeze, but no mutant generator was given (pass --repo)');
  const decidingMined = m.tasks.mined.filter((t) => !calMined.has(t.key)).map((t) => t.key);
  const decidingWt = (m.tasks.write_test ?? []).filter((t) => !calWt.has(t.key)).map((t) => t.key);
  if (decidingMined.length > size) violations.push(`${decidingMined.length} deciding mined tasks exceed the holdout size ${size}`);
  if (decidingWt.length > size) violations.push(`${decidingWt.length} deciding write_test tasks exceed the holdout size ${size}`);
  if (violations.length) return { status: 'REFUSED', violations };

  const reasons: string[] = [];
  if (decidingMined.length < size) reasons.push(`mined: ${decidingMined.length} of ${size} deciding tasks`);
  if (decidingWt.length > 0 && decidingWt.length < WRITE_TEST_HOLDOUT_MIN) reasons.push(`write_test: ${decidingWt.length} deciding tasks, fewer than ${WRITE_TEST_HOLDOUT_MIN}`);
  const mutants = m.tasks.mutant && opts.makeMutant ? generateMutants(ex, opts.makeMutant, m.tasks.mutant.proposed_tiers, size, m.tasks.mutant.max_per_source ?? Infinity) : [];
  if (m.tasks.mutant && mutants.length < size) reasons.push(`mutant: ${mutants.length} of ${size} eligible mutants generated`);
  if (reasons.length) return { status: 'HOLD', reasons };

  const now = opts.now ?? new Date().toISOString();
  const record: FreezeRecord = {
    epoch: opts.epoch, manifest_sha256: sha, frozen_at: now, origin_sha: opts.origin.sha, version: opts.origin.version, holdout_size: size, operator: opts.operator ?? null,
    counts: { mined: decidingMined.length, mutant: mutants.length, write_test: decidingWt.length, calibration: calMined.size + calWt.size },
    keys: { mined: decidingMined, mutant: mutants.map((t) => t.commit), write_test: decidingWt, calibration: [...calMined, ...calWt] },
  };
  if (opts.dryRun) return { status: 'VALID_DRY_RUN', ...record };
  const role = (cal: Set<string>, k: string) => (cal.has(k) ? 'calibration' : 'deciding');
  db.transaction(() => {
    // re-checked inside the transaction: nothing may have frozen this epoch since the checks above
    if (TABLES.some(([t]) => db.prepare(`SELECT 1 FROM ${t} WHERE epoch = ? LIMIT 1`).get(opts.epoch))) throw new Error(`HOLDOUT_EPOCH_OCCUPIED: epoch ${opts.epoch}`);
    // plain INSERT: a key already frozen anywhere violates the primary key and rolls the whole freeze back
    const mined = db.prepare('INSERT INTO gym_holdout (commit_sha, created_at, epoch, role) VALUES (?, ?, ?, ?)');
    for (const t of m.tasks.mined) mined.run(t.key, now, opts.epoch, role(calMined, t.key));
    const wt = db.prepare('INSERT INTO gym_write_test_holdout (key, task_json, created_at, epoch, role) VALUES (?, ?, ?, ?, ?)');
    for (const t of m.tasks.write_test ?? []) wt.run(t.key, JSON.stringify(wtPool.get(t.key)), now, opts.epoch, role(calWt, t.key));
    const mu = db.prepare("INSERT INTO gym_mutant_holdout (key, task_json, created_at, epoch, role) VALUES (?, ?, ?, ?, 'deciding')");
    for (const t of mutants) mu.run(t.commit, JSON.stringify(t), now, opts.epoch);
    db.prepare(`INSERT INTO gym_holdout_freezes (epoch, manifest_sha256, frozen_at, origin_sha, version, holdout_size, counts_json, operator, manifest_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(opts.epoch, sha, now, record.origin_sha, record.version, size, JSON.stringify(record.counts), record.operator, JSON.stringify(input));
    opts.onFrozen?.(record);
  })();
  return { status: 'FROZEN', ...record };
}

/**
 * Epoch 1 (operator 14-10): the manifest builder uses exactly the freeze's exclusions (holdoutExclusions: gym failures AND
 * failed maker leases' changed_files in each dream window, frozen, TG-001, trial-attempted, derived), so a built manifest
 * cannot miss an exposure source the freeze checks. With a base manifest its still-eligible tasks are kept and refused ones
 * dropped with the reason; the mined part is refilled to `size` by a deterministic every-k-th spread over the remaining
 * eligible pool (sorted by key). A pool too small is reported as `shortfall`, never padded. A write_test part with fewer than
 * WRITE_TEST_HOLDOUT_MIN eligible tasks is left out (noted). Mutants are generated at freeze (their keys depend on HEAD).
 */
export interface BuildOptions {
  epoch: number; size: number; pool: { mined: GymTask[]; writeTest?: FailureTask[] }; tiers: number[];
  base?: Record<string, unknown>; provenance: Record<string, unknown>; now?: string; deciding?: 'mutant' | 'mined'; maxPerSource?: number;
}
export function buildHoldoutManifest(db: Database, o: BuildOptions) {
  const ex = holdoutExclusions(db);
  const base = o.base as Partial<HoldoutManifest> | undefined;
  const dropped: Array<{ key: string; reason: string }> = []; const notes: string[] = [];
  const minedPool = new Map(o.pool.mined.map((t) => [t.commit, t]));
  const wtPool = new Map((o.pool.writeTest ?? []).map((t) => [t.commit, t]));
  const keep = (list: ManifestTask[] | undefined, pool: Map<string, GymTask | FailureTask>): string[] => (list ?? []).flatMap((t) => {
    const p = pool.get(t.key);
    const why = !p ? 'not in the eligible pool' : p.source !== t.source ? `source changed to ${p.source}` : exclusionReason(ex, p);
    if (why) { dropped.push({ key: t.key, reason: why }); return []; }
    return [t.key];
  });
  const keptMined = keep(base?.tasks?.mined, minedPool).slice(0, o.size);
  const remaining = o.pool.mined.filter((t) => !keptMined.includes(t.commit) && !exclusionReason(ex, t)).sort((a, b) => a.commit.localeCompare(b.commit));
  const need = Math.max(0, o.size - keptMined.length);
  const added: string[] = [];
  if (remaining.length <= need) added.push(...remaining.map((t) => t.commit));
  else { const step = remaining.length / need; for (let i = 0; i < need; i++) added.push(remaining[Math.floor(i * step)].commit); }
  const mined = [...keptMined, ...added].sort();
  const keptWt = keep(base?.tasks?.write_test, wtPool);
  const wt = [...new Set([...keptWt, ...[...wtPool.values()].filter((t) => !exclusionReason(ex, t)).map((t) => t.commit)])].sort().slice(0, o.size);
  if (wt.length < WRITE_TEST_HOLDOUT_MIN) notes.push(`write_test left out: ${wt.length} eligible, fewer than ${WRITE_TEST_HOLDOUT_MIN}`);
  const deciding = o.deciding ?? 'mutant';
  const manifest: Record<string, unknown> = {
    manifest_version: 1, holdout_epoch: o.epoch, status: 'PROPOSED_NOT_FROZEN', freeze_timestamp: null,
    provenance: { ...o.provenance, built_at: o.now ?? new Date().toISOString(), ...(base?.manifest_sha256 ? { rebuilt_from_sha256: base.manifest_sha256 } : {}) },
    evaluation_policy: { holdout_size: o.size, deciding, mined_role: deciding === 'mutant' ? 'no_regression' : 'deciding', promotion_rule: 'unchanged (as deployed)' },
    selection_rule: {
      excluded: ['frozen in any holdout epoch', 'TG-001 task keys', 'attempted in a genome trial',
        'dream exposure: commits, source / out-of-scope files and run ids of gym failures AND failed maker leases (changed_files) in the 24 h before each dream genome',
        'derived tasks on an exposed file, base commit or run'],
      mined: base ? 'base manifest tasks still eligible, refilled by every-k-th spread over the remaining eligible pool (sorted by key)' : 'every-k-th spread over the eligible pool (sorted by key)',
      write_test: `every eligible failure-derived task (≤ size, ≥ ${WRITE_TEST_HOLDOUT_MIN} or none)`,
    },
    exclusion_counts: { frozen: ex.frozen.size, tg_keys: ex.tg.size, trial_attempted: ex.trialAttempted.size, dream_genomes: ex.dreamGenomes,
      dream_exposed_commits: ex.exposedCommits.size, dream_exposed_sources: ex.exposedSources.size, dream_exposed_runs: ex.exposedRuns.size },
    tasks: {
      mined: mined.map((k) => ({ key: k, source: minedPool.get(k)!.source })),
      ...(wt.length >= WRITE_TEST_HOLDOUT_MIN ? { write_test: wt.map((k) => ({ key: k, source: wtPool.get(k)!.source })) } : {}),
      mutant: { generated_at_freeze: true, proposed_tiers: o.tiers, ...(o.maxPerSource ? { max_per_source: o.maxPerSource } : {}) },
    },
  };
  manifest.manifest_sha256 = manifestSha256(manifest);
  return { manifest, dropped, added, notes, shortfall: Math.max(0, o.size - mined.length) };
}
