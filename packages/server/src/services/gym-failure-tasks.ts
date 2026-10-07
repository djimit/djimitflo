import { execFileSync } from 'node:child_process';
import type { Database } from 'better-sqlite3';
import { SENSITIVE_SERVICE, type GymTask } from './gym-task-miner';
import { mutate, rng } from './gym-mutants';

/**
 * Batch-8 (06-10): gym tasks derived from REAL production failures — the headroom is there (prod: real doc-drift /
 * test-gap makers succeed 28/118 = 24 %, the mined + mutant gym 81 %). A failed oracle-lane proposal (status
 * 'regressed' = the maker's change failed its gates; infra_failed / no_change / parked are NOT maker failures) with a
 * grounding target + test artifact becomes a 'write_test' task: at the run's base commit, write <artifact> covering
 * <target>; the oracle is the lane's own one command (`npx vitest run <artifact>`).
 *
 * The run's base commit is not recorded on runs/leases (prod 06-10: 0/30), so the base is the newest main commit at or
 * before the run started (`git rev-list -1 --before=<created_at> HEAD`) — deterministic, on main's history; the worker's
 * precheck (oracle red at base) discards a task whose gap was already closed.
 *
 * A 'write_test' task needs worker support (the maker edits the TEST file, the target must stay unchanged, and the
 * test must import the target): served ONLY to a worker announcing capabilities ['write_test'] — today's worker would
 * restore '<commit>^:<source>' for a 'fail:' key and fail. Mutation lanes are skipped: their oracle (mutation-gain) is
 * not runnable by the worker contract. Never part of the frozen holdouts (those only see mined + seeded mutant tasks).
 * B8 oracle: any green test that imports the target would pass "vitest exits 0", so every task carries
 * WRITE_TEST_MUTANTS seeded single-operator mutants of the target (gym-mutants' operators and PRNG, deterministic per
 * base + target). Success = the test is green on the real target AND red on at least one mutant written over it; a test
 * that kills no mutant constrains nothing. A target without a valid mutant is not served.
 * GYM_FAILURE_TASKS_ENABLED=true (default off).
 */
export const gymFailureTasksEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.GYM_FAILURE_TASKS_ENABLED === 'true';
export const FAILURE_TASK_CAPABILITY = 'write_test';

export const WRITE_TEST_MUTANTS = 3;
export const WRITE_TEST_ORACLE = 'vitest on <source> green with the real <target>, and red with at least one of <mutants> written over <target>';
export interface TargetMutant { key: string; content: string }
export interface FailureTask extends GymTask { kind: 'write_test'; base: string; target: string; run_id: string; lane: 'test-gap' | 'exports'; mutants: TargetMutant[]; oracle: string }

/** Up to `k` distinct single-operator mutants of the target, seeded like gym-mutants: the same base + target give the same mutants. */
export function targetMutants(original: string, base: string, target: string, k = WRITE_TEST_MUTANTS): TargetMutant[] {
  const out: TargetMutant[] = []; const seen = new Set<string>();
  for (let seed = 1; seed <= 50 && out.length < k; seed++) {
    const content = mutate(original, 1, rng(seed * 7919 + base.charCodeAt(0)));
    if (!content || content === original || seen.has(content)) continue;
    seen.add(content); out.push({ key: `mut:${base.slice(0, 12)}:${target}:1:${seed}`, content });
  }
  return out;
}

const TEST_ARTIFACT = /^packages\/server\/src\/__tests__\/[A-Za-z0-9._-]+\.test\.ts$/;
const TARGET = /^packages\/server\/src\/services\/([A-Za-z0-9_-]+)\.ts$/;
const COMMAND = /^npx vitest run src\/__tests__\/[A-Za-z0-9._-]+\.test\.ts$/;
// a run that touched any of these is never replayed (same boundary as the evolve loop and the miner)
const SENSITIVE_PATH = /(^|\/)(\.github|auth|secrets?|deploy|tokens?|credentials?|spawn|approvals?)(\/|[-_.]|$)|(^|[-_/])(auth|secrets?|token|credential|approval)[-_.]/i;

export interface FailureRow { proposal_id: string; evidence: string; artifact: string | null; target: string | null; command: string | null; run_id: string | null; run_created_at: string | null; changed_files: string | null }

/** The failed oracle-lane proposals with their latest loop run (read-only). */
export function failureRows(db: Database): FailureRow[] {
  try {
    return db.prepare(`SELECT s.id AS proposal_id, s.evidence_refs_json AS evidence,
        json_extract(s.grounding_json, '$.artifactPath') AS artifact, json_extract(s.grounding_json, '$.target') AS target,
        json_extract(s.grounding_json, '$.runtimeCommand') AS command,
        (SELECT r.id FROM loop_runs r JOIN goals g ON g.id = r.goal_id WHERE g.improvement_id = s.id ORDER BY r.created_at DESC LIMIT 1) AS run_id,
        (SELECT r.created_at FROM loop_runs r JOIN goals g ON g.id = r.goal_id WHERE g.improvement_id = s.id ORDER BY r.created_at DESC LIMIT 1) AS run_created_at,
        (SELECT group_concat(json_extract(l.metadata, '$.changed_files'), '|') FROM worker_leases l JOIN loop_runs r ON r.id = l.loop_run_id JOIN goals g ON g.id = r.goal_id
          WHERE g.improvement_id = s.id AND l.role = 'maker') AS changed_files
      FROM self_improvements s WHERE s.source = 'gap_analysis' AND s.status = 'regressed'
      ORDER BY s.updated_at DESC LIMIT 500`).all() as FailureRow[];
  } catch { return []; }
}

const laneOf = (evidence: string): FailureTask['lane'] | null =>
  /mutation-gap:/.test(evidence) ? null : /test-gap:[^"]*#exports/.test(evidence) ? 'exports' : /test-gap:/.test(evidence) ? 'test-gap' : null;

/** Pure: which failure rows qualify, before any git lookup. */
export function qualifyingFailures(rows: FailureRow[]): Array<FailureRow & { lane: FailureTask['lane'] }> {
  const out: Array<FailureRow & { lane: FailureTask['lane'] }> = []; const seen = new Set<string>();
  for (const r of rows) {
    const lane = laneOf(r.evidence ?? '');
    if (!lane || !r.run_id || !r.run_created_at || !r.artifact || !r.target || !r.command) continue;
    if (!TEST_ARTIFACT.test(r.artifact) || !TARGET.test(r.target) || !COMMAND.test(r.command.trim())) continue; // a deterministic one-command oracle only
    if (SENSITIVE_SERVICE.test(TARGET.exec(r.target)![1]) || SENSITIVE_PATH.test(r.artifact)) continue;
    if ((r.changed_files ?? '').split(/[|,"[\]\s]+/).filter(Boolean).some((f) => SENSITIVE_PATH.test(f))) continue;
    const key = `${r.target}|${r.artifact}`; if (seen.has(key)) continue; seen.add(key); // one task per gap
    out.push({ ...r, lane });
  }
  return out;
}

export interface GitLookup { baseAt(isoTime: string): string | null; exists(commit: string, file: string): boolean; show(commit: string, file: string): string | null }

export function gitLookup(repo: string): GitLookup {
  const git = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
  return {
    baseAt: (iso) => { try { return git(['rev-list', '-1', '--first-parent', `--before=${iso}`, 'HEAD']) || null; } catch { return null; } },
    exists: (c, f) => { try { git(['cat-file', '-e', `${c}:${f}`]); return true; } catch { return false; } },
    show: (c, f) => { try { return execFileSync('git', ['-C', repo, 'show', `${c}:${f}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }); } catch { return null; } },
  };
}

/** Failure-derived 'write_test' tasks: the target exists at the base, the test artifact does not yet, and the target has a mutant. */
export function failureDerivedTasks(db: Database, lookup: GitLookup): FailureTask[] {
  const tasks: FailureTask[] = [];
  for (const r of qualifyingFailures(failureRows(db))) {
    const base = lookup.baseAt(r.run_created_at!);
    if (!base || !/^[0-9a-f]{7,40}$/.test(base) || !lookup.exists(base, r.target!) || lookup.exists(base, r.artifact!)) continue;
    const original = lookup.show(base, r.target!);
    const mutants = original ? targetMutants(original, base, r.target!) : [];
    if (!mutants.length) continue; // nothing to kill: a green test could not be told from one that constrains nothing
    tasks.push({ commit: `fail:${r.run_id}`, kind: 'write_test', base, source: r.artifact!, tests: [r.artifact!], target: r.target!, sourceLines: original!.split('\n').length, run_id: r.run_id!, lane: r.lane, mutants, oracle: WRITE_TEST_ORACLE });
  }
  return tasks;
}

/** Evidence: failure-derived tasks available / attempted / solved (30 d attempts). */
export function failureTaskEvidence(db: Database, lookup: GitLookup | null, env: NodeJS.ProcessEnv = process.env) {
  const q = (sql: string) => { try { return (db.prepare(sql).get() as { n: number }).n; } catch { return 0; } };
  const qualifying = qualifyingFailures(failureRows(db)).length;
  let available: number | null = null;
  if (lookup) { try { available = failureDerivedTasks(db, lookup).length; } catch { available = null; } }
  const where = "loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym.commit') LIKE 'fail:%'";
  return {
    enabled: gymFailureTasksEnabled(env), qualifying_failures: qualifying, available,
    attempted: q(`SELECT COUNT(*) AS n FROM loop_runs WHERE ${where} AND json_extract(metadata, '$.gym_result.status') IN ('success', 'failure')`),
    solved: q(`SELECT COUNT(*) AS n FROM loop_runs WHERE ${where} AND json_extract(metadata, '$.gym_result.status') = 'success'`),
    note: "served only to workers announcing capabilities ['write_test']; mutation-lane failures are skipped (oracle not runnable by the worker)",
  };
}
