import type { Database } from 'better-sqlite3';

/**
 * Holdout epoch 1 (14-10): what may never enter a frozen holdout, shared by the manifest freeze (holdout-manifest) and the
 * claim-time freeze (genome-registry holdout / mutantHoldout / writeTestHoldout). Before this the claim-time freeze excluded
 * only tasks frozen by another epoch, so a new epoch would have frozen dream-exposed mined tasks and mutants on exposed files.
 *
 * - frozen: every key in any holdout table, any epoch;
 * - tg: every TG-001 task key (tg_attempts + the frozen tg_experiments manifests) — diagnostic, prior exposure;
 * - trialAttempted: every task a genome trial ran on;
 * - dream exposure: what dreamInputs / failureClusters (dream-evolution) showed the dream, re-derived per dream genome
 *   (origin 'dream'): the gym failures and failed maker leases of the 24 h before its created_at. Their commits, source
 *   files (gym source, out-of-scope files, maker changed_files) and run ids are exposed.
 */
export interface HoldoutExclusions {
  frozen: Set<string>; tg: Set<string>; trialAttempted: Set<string>;
  exposedCommits: Set<string>; exposedSources: Set<string>; exposedRuns: Set<string>; dreamGenomes: number;
}
export const DREAM_EXPOSURE_WINDOW_MS = 86_400_000;

const list = (raw: unknown): string[] => {
  if (typeof raw !== 'string') return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
};

export function holdoutExclusions(db: Database, windowMs = DREAM_EXPOSURE_WINDOW_MS): HoldoutExclusions {
  const all = <T>(sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } };
  const keys = (sql: string) => new Set(all<{ k: string | null }>(sql).map((r) => r.k).filter((k): k is string => Boolean(k)));
  const frozen = keys('SELECT commit_sha AS k FROM gym_holdout UNION SELECT key AS k FROM gym_mutant_holdout UNION SELECT key AS k FROM gym_write_test_holdout');
  const tg = keys('SELECT DISTINCT task_key AS k FROM tg_attempts');
  for (const r of all<{ m: string }>('SELECT manifest_json AS m FROM tg_experiments')) {
    try { for (const t of (JSON.parse(r.m) as { tasks?: Array<{ key?: string }> }).tasks ?? []) if (t.key) tg.add(t.key); } catch { /* malformed manifest: tg_attempts still counts */ }
  }
  const trialAttempted = keys(`SELECT DISTINCT json_extract(metadata, '$.gym.commit') AS k FROM loop_runs
    WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym.genome') IS NOT NULL`);
  const exposedCommits = new Set<string>(); const exposedSources = new Set<string>(); const exposedRuns = new Set<string>();
  const dreams = all<{ created_at: string }>("SELECT created_at FROM maker_genomes WHERE origin = 'dream'");
  for (const d of dreams) {
    const end = Date.parse(d.created_at); if (!Number.isFinite(end)) continue;
    const from = new Date(end - windowMs).toISOString(); const to = new Date(end).toISOString();
    for (const r of all<{ id: string; commit: string | null; source: string | null; reason: string | null }>(`SELECT id, json_extract(metadata, '$.gym.commit') AS "commit",
        json_extract(metadata, '$.gym.source') AS source, json_extract(metadata, '$.gym_result.reason') AS reason FROM loop_runs
      WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym_result.status') = 'failure' AND created_at >= ? AND created_at <= ?
        AND json_extract(metadata, '$.gym.genome') IS NULL AND json_extract(metadata, '$.gym.canary') IS NULL`, from, to)) {
      exposedRuns.add(r.id);
      if (r.commit) exposedCommits.add(r.commit);
      if (r.source) exposedSources.add(r.source);
      for (const f of /^out of scope:\s*(.+)$/i.exec(String(r.reason ?? ''))?.[1]?.split(/,\s*/) ?? []) if (f) exposedSources.add(f.trim());
    }
    for (const r of all<{ id: string; run: string | null; files: string | null }>(`SELECT id, loop_run_id AS run, json_extract(metadata, '$.changed_files') AS files FROM worker_leases
      WHERE role = 'maker' AND status = 'failed' AND created_at >= ? AND created_at <= ?`, from, to)) {
      exposedRuns.add(r.id); if (r.run) exposedRuns.add(r.run);
      for (const f of list(r.files)) exposedSources.add(f);
    }
  }
  return { frozen, tg, trialAttempted, exposedCommits, exposedSources, exposedRuns, dreamGenomes: dreams.length };
}

/** Why a task may not be frozen (null = eligible). Derived tasks (mutant, write_test) are also checked on what they came from. */
export function exclusionReason(ex: HoldoutExclusions, t: { commit: string; source?: string; base?: string; target?: string; run_id?: string }): string | null {
  if (ex.frozen.has(t.commit)) return 'already frozen in a holdout epoch';
  if (ex.tg.has(t.commit)) return 'TG-001 task key';
  if (ex.trialAttempted.has(t.commit)) return 'attempted in a genome trial';
  if (ex.exposedCommits.has(t.commit)) return 'dream-exposed commit';
  for (const f of [t.source, t.target]) if (f && ex.exposedSources.has(f)) return `dream-exposed source file ${f}`;
  if (t.base && [...ex.exposedCommits].some((c) => c.length >= 7 && (c.startsWith(t.base!) || t.base!.startsWith(c)))) return `derived from dream-exposed commit ${t.base}`;
  if (t.run_id && ex.exposedRuns.has(t.run_id)) return `derived from dream-exposed run ${t.run_id}`;
  return null;
}

/**
 * Holdout size: explicit and bounded. HOLDOUT_SIZE (env) or the manifest's holdout_size; both given and different is an
 * error (never silently pick one). Default 20 (the size every epoch so far was frozen at).
 */
export const DEFAULT_HOLDOUT_SIZE = 20;
export const HOLDOUT_SIZE_MIN = 10;
export const HOLDOUT_SIZE_MAX = 200;
export type HoldoutSize = { ok: true; size: number; source: 'env' | 'manifest' | 'default' } | { ok: false; reason: string };
export function resolveHoldoutSize(env: NodeJS.ProcessEnv = process.env, manifestSize?: unknown): HoldoutSize {
  const parse = (raw: unknown, from: string): number | string => {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
    if (!Number.isInteger(n)) return `${from} holdout size ${JSON.stringify(raw)} is not an integer`;
    if (n < HOLDOUT_SIZE_MIN || n > HOLDOUT_SIZE_MAX) return `${from} holdout size ${n} is outside [${HOLDOUT_SIZE_MIN}, ${HOLDOUT_SIZE_MAX}]`;
    return n;
  };
  const fromEnv = env.HOLDOUT_SIZE !== undefined && env.HOLDOUT_SIZE !== '' ? parse(env.HOLDOUT_SIZE, 'HOLDOUT_SIZE') : undefined;
  const fromManifest = manifestSize !== undefined && manifestSize !== null ? parse(manifestSize, 'manifest') : undefined;
  if (typeof fromEnv === 'string') return { ok: false, reason: fromEnv };
  if (typeof fromManifest === 'string') return { ok: false, reason: fromManifest };
  if (fromEnv !== undefined && fromManifest !== undefined && fromEnv !== fromManifest) return { ok: false, reason: `HOLDOUT_SIZE=${fromEnv} conflicts with the manifest holdout_size ${fromManifest}` };
  if (fromManifest !== undefined) return { ok: true, size: fromManifest, source: 'manifest' };
  if (fromEnv !== undefined) return { ok: true, size: fromEnv, source: 'env' };
  return { ok: true, size: DEFAULT_HOLDOUT_SIZE, source: 'default' };
}
