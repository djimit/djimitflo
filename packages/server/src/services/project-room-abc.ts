/**
 * PR-ABC-001 (docs/research/project-room/PREREG.md): does the project room earn its calls?
 *   A  the current workflow, unchanged (room off)
 *   B  one planner call, then the same maker (room on, variant single)
 *   C  architecture reviewer, then planner, then the same maker (room on, variant two_stage)
 * Same task, same source, same downstream maker and the same total token budget in every arm; C gets nothing extra for
 * having more roles. A vs B/C compares whole workflows.
 *
 * A task is a commit mined from the repository's own history (gym-task-miner): the arm works on the PARENT commit, in a
 * repository that does not contain the solution commit, with the commit subject as its finding. The commit's own test files
 * are the hidden acceptance check: copied in and run only after the maker is done, never shown to planner or maker.
 * Every task-arm runs in a fresh fetch of the parent, a fresh in-memory database and a fresh LoopService: no room history,
 * memory or solution can cross arms.
 * ponytail: arms run one after another in this process (the room mode is process environment); parallel arms need a
 * child process per arm.
 */
import { execFileSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from './loop-service';
import { mineGymTasks, type GymTask } from './gym-task-miner';
import { mcnemarExact, newcombePaired, shuffle } from './asg/harness/stats';
import { artifactDigest, PLAN_FORBIDDEN_SCOPE } from './plan-artifact';
import { roomTokens, runProjectRoom, type ProfileRunner } from './project-room';

export type Arm = 'A' | 'B' | 'C';
export const ARMS: Arm[] = ['A', 'B', 'C'];
/** A failed evaluation is not a failed task; a task-arm that never ran stays in the denominator as NOT_RUN. */
export type Observation = 'PASS' | 'FAIL' | 'EVALUATION_ERROR' | 'NOT_RUN';
export interface AbcTask { id: string; set: 'dev' | 'holdout'; commit: string; parent: string; source: string; tests: string[]; subject: string }
export interface AbcManifest { schema_version: 1; experiment: 'PR-ABC-001'; frozen_at_commit: string; seed: number; budget: { max_tokens: number; max_runtime_ms: number };
  /** argv of the hidden check, run in the maker's worktree; `{tests}` expands to the task's test files */
  check: string[]; tasks: AbcTask[]; digest: string }
export interface AbcRow { task: string; set: 'dev' | 'holdout'; arm: Arm; order: number; observation: Observation; reason: string | null; tokens: number | null; duration_ms: number | null; plan_version: number | null }

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** Freeze the task sets. Fewer real tasks than asked for is an error: sets are never padded. */
export function freezeManifest(repo: string, opts: { seed: number; dev?: number; holdout?: number; check: string[]; budget?: AbcManifest['budget']; mine?: (repo: string) => GymTask[] }): AbcManifest {
  const dev = opts.dev ?? 20, holdout = opts.holdout ?? 10;
  // a task on a protected path is excluded for every arm: a plan may not schedule such an edit, so B and C could not compete on it
  const mined = (opts.mine ?? ((r) => mineGymTasks(r)))(repo).filter((t) => !PLAN_FORBIDDEN_SCOPE.some((re) => re.test(t.source))).sort((a, b) => a.commit.localeCompare(b.commit));
  if (mined.length < dev + holdout) throw new Error(`PR_ABC_NOT_ENOUGH_TASKS: ${mined.length} mined, ${dev + holdout} needed`);
  const tasks = shuffle(mined, opts.seed).slice(0, dev + holdout).map((t, i): AbcTask => ({ id: t.commit.slice(0, 12), set: i < dev ? 'dev' : 'holdout', commit: t.commit, parent: git(repo, ['rev-parse', `${t.commit}^`]),
    source: t.source, tests: t.tests, subject: git(repo, ['log', '-1', '--format=%s', t.commit]) }));
  const body = { schema_version: 1 as const, experiment: 'PR-ABC-001' as const, frozen_at_commit: git(repo, ['rev-parse', 'HEAD']), seed: opts.seed, budget: opts.budget ?? { max_tokens: 400_000, max_runtime_ms: 1_800_000 }, check: opts.check, tasks };
  return { ...body, digest: artifactDigest(body) };
}
export const manifestIntact = (m: AbcManifest): boolean => m.digest === artifactDigest(m as unknown as Record<string, unknown>);
/** The order of the three arms for one task: fixed by the task id, balanced over tasks, the same on every rerun. */
export function armOrder(taskId: string): Arm[] {
  const perms: Arm[][] = [['A', 'B', 'C'], ['A', 'C', 'B'], ['B', 'A', 'C'], ['B', 'C', 'A'], ['C', 'A', 'B'], ['C', 'B', 'A']];
  return perms[parseInt(createHash('sha256').update(`pr-abc-001:${taskId}`).digest('hex').slice(0, 8), 16) % 6];
}

export interface AbcDeps { runtime: string; profileRunner: (db: Database.Database) => ProfileRunner;
  /** test seam: replaces the execution engine of the arm's LoopService; undefined = the real engine and runtime */
  engine?: (db: Database.Database) => unknown;
  /** before the maker is prepared (tests: mark the runtime available) */
  prepare?: (loops: LoopService) => void }
const INFRA = /PROJECT_ROOM_(CALL_FAILED|CALL_NOT_STARTED|RUNTIME_NOT_READ_ONLY|READ_ONLY_VIOLATED|IN_PROGRESS|DIRTY_SOURCE)|LOOP_WORKER_(EXECUTION_DENIED|APPROVAL_REQUIRED)|RUNTIME_|ENOENT|EACCES/;

/** One task in one arm, in its own workspace and database. Never throws: an error becomes EVALUATION_ERROR with its reason. */
export async function runArm(manifest: AbcManifest, task: AbcTask, arm: Arm, repo: string, deps: AbcDeps, workRoot: string): Promise<AbcRow> {
  const started = Date.now(); const order = armOrder(task.id).indexOf(arm);
  const row = (observation: Observation, reason: string | null, extra: Partial<AbcRow> = {}): AbcRow => ({ task: task.id, set: task.set, arm, order, observation, reason, tokens: null, duration_ms: Date.now() - started, plan_version: null, ...extra });
  const dir = path.join(workRoot, `${task.id}-${arm}`); const clone = path.join(dir, 'repo');
  const saved = { mode: process.env.COMMONS_PROJECT_ROOM_MODE, wt: process.env.LOOP_WORKTREE_ROOT };
  const db = new Database(':memory:');
  try {
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(clone, { recursive: true });
    // only the parent and its ancestors: the solution commit is not in this repository
    git(clone, ['init', '-q']);
    git(clone, ['-c', 'uploadpack.allowAnySHA1InWant=true', 'fetch', '-q', '--no-tags', repo, task.parent]);
    git(clone, ['checkout', '-q', '-B', 'main', 'FETCH_HEAD']);
    try { git(clone, ['cat-file', '-e', `${task.commit}^{commit}`]); return row('EVALUATION_ERROR', 'the workspace contains the solution commit'); } catch { /* as intended */ }
    db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF');
    process.env.COMMONS_PROJECT_ROOM_MODE = arm === 'A' ? 'off' : 'on'; process.env.LOOP_WORKTREE_ROOT = path.join(dir, 'worktrees');
    const loops = new LoopService(db, path.join(dir, 'evidence'));
    if (deps.engine) (loops.workerExecutor as unknown as { executionEngine: unknown }).executionEngine = deps.engine(db);
    deps.prepare?.(loops);
    const now = new Date().toISOString(); const goalId = `abc-${task.id}-${arm}`;
    db.prepare(`INSERT INTO goals (id, objective, constraints_json, acceptance_criteria_json, risk_class, budget_json, status, metadata, created_at, updated_at) VALUES (?, ?, '[]', ?, 'low', ?, 'running', ?, ?, ?)`)
      .run(goalId, task.subject, JSON.stringify([`the behaviour described by "${task.subject}" is implemented in ${task.source}`]), JSON.stringify(manifest.budget),
        JSON.stringify(arm === 'A' ? {} : { task_profile: 'project_room', project_room: { variant: arm === 'B' ? 'single' : 'two_stage' } }), now, now);
    let planVersion: number | null = null;
    if (arm !== 'A') {
      const room = await runProjectRoom(db, goalId, clone, deps.profileRunner(db));
      if (room.status === 'blocked') return row(INFRA.test(room.reason) ? 'EVALUATION_ERROR' : 'FAIL', room.reason, { tokens: roomTokens(db, goalId) }); // no usable plan = this workflow did not solve the task
      planVersion = room.plan.version;
    }
    const run = loops.startDocDriftAndSmallFixLoop({ repository_path: clone, goal_id: goalId, target_finding: { file_path: task.source, description: task.subject, category: 'bug' } });
    const maker = loops.continueLoopRun(run.id, { runtime: deps.runtime as never, max_assignments: 1, max_maker_workers: 1 }).leases.find((l) => l.role === 'maker' && l.status === 'prepared');
    if (!maker) return row('EVALUATION_ERROR', 'no maker lease was prepared');
    await loops.executeWorker(run.id, { lease_id: maker.id, timeout_ms: Math.min(600_000, manifest.budget.max_runtime_ms) });
    const lease = loops.getWorkerLease(maker.id);
    const tokens = roomTokens(db, goalId) + (Number((lease.metadata.runtime_usage as { total_tokens?: unknown } | undefined)?.total_tokens) || 0);
    if (lease.status !== 'completed') return row('EVALUATION_ERROR', `maker ${lease.status}: ${String(lease.metadata.failure_reason ?? 'no reason recorded').slice(0, 160)}`, { tokens, plan_version: planVersion });
    // hidden acceptance check: the solution commit's tests, placed only now
    const wt = lease.worktree_path!;
    for (const t of task.tests) { fs.mkdirSync(path.dirname(path.join(wt, t)), { recursive: true }); fs.writeFileSync(path.join(wt, t), execFileSync('git', ['show', `${task.commit}:${t}`], { cwd: repo, maxBuffer: 16 * 1024 * 1024 })); }
    const argv = manifest.check.flatMap((a) => (a === '{tests}' ? task.tests : [a]));
    const check = spawnSync(argv[0], argv.slice(1), { cwd: wt, encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
    if (check.error || check.status === null) return row('EVALUATION_ERROR', `check did not run: ${check.error?.message ?? `signal ${check.signal}`}`.slice(0, 200), { tokens, plan_version: planVersion });
    return row(check.status === 0 ? 'PASS' : 'FAIL', check.status === 0 ? null : `hidden check exit ${check.status}`, { tokens, plan_version: planVersion });
  } catch (error) {
    return row('EVALUATION_ERROR', (error instanceof Error ? error.message : String(error)).slice(0, 200));
  } finally {
    db.close();
    for (const [k, v] of [['COMMONS_PROJECT_ROOM_MODE', saved.mode], ['LOOP_WORKTREE_ROOT', saved.wt]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/**
 * Per arm: every task of the set stays in the denominator (a task-arm without a row is NOT_RUN). Paired comparisons use only
 * tasks where BOTH arms have PASS or FAIL; the number of such pairs is reported. With fewer than 6 usable pairs the
 * interval is null: reported as insufficient, never as "no difference".
 */
export function analyse(manifest: AbcManifest, rows: AbcRow[], set: 'dev' | 'holdout') {
  const tasks = manifest.tasks.filter((t) => t.set === set);
  const last = new Map<string, AbcRow>(); for (const r of rows) if (r.set === set) last.set(`${r.task}:${r.arm}`, r); // one row per task-arm: a rerun replaces, never adds a task
  const obs = (task: string, arm: Arm): Observation => last.get(`${task}:${arm}`)?.observation ?? 'NOT_RUN';
  const arms = Object.fromEntries(ARMS.map((arm) => {
    const counts = { PASS: 0, FAIL: 0, EVALUATION_ERROR: 0, NOT_RUN: 0 }; for (const t of tasks) counts[obs(t.id, arm)] += 1;
    const mine = tasks.map((t) => last.get(`${t.id}:${arm}`)).filter((r): r is AbcRow => Boolean(r));
    const tokens = mine.map((r) => r.tokens).filter((x): x is number => typeof x === 'number');
    return [arm, { n_tasks: tasks.length, ...counts, pass_rate_of_all: tasks.length ? +(counts.PASS / tasks.length).toFixed(4) : null,
      tokens_total: tokens.length === mine.length && mine.length ? tokens.reduce((a, b) => a + b, 0) : null, // unknown if any run did not report tokens
      tokens_per_pass: counts.PASS && tokens.length === mine.length ? Math.round(tokens.reduce((a, b) => a + b, 0) / counts.PASS) : null }];
  }));
  const pair = (x: Arm, y: Arm) => {
    let both = 0, onlyX = 0, onlyY = 0, neither = 0;
    for (const t of tasks) { const a = obs(t.id, x), b = obs(t.id, y); if (!['PASS', 'FAIL'].includes(a) || !['PASS', 'FAIL'].includes(b)) continue;
      if (a === 'PASS' && b === 'PASS') both += 1; else if (a === 'PASS') onlyX += 1; else if (b === 'PASS') onlyY += 1; else neither += 1; }
    const n = both + onlyX + onlyY + neither; const ci = n >= 6 ? newcombePaired(both, onlyX, onlyY, neither) : null;
    return { comparison: `${x} − ${y}`, usable_pairs: n, dropped_pairs: tasks.length - n, both_pass: both, only_first: onlyX, only_second: onlyY, neither,
      diff: n ? +((onlyX - onlyY) / n).toFixed(4) : null, ci95: ci ? ci.ci.map((v) => +v.toFixed(4)) : null, mcnemar_p: n ? +mcnemarExact(onlyX, onlyY).p.toFixed(4) : null, status: n >= 6 ? 'ok' : 'insufficient' };
  };
  return { experiment: manifest.experiment, manifest_digest: manifest.digest, set, arms, paired: [pair('C', 'B'), pair('B', 'A'), pair('C', 'A')],
    note: 'Pilot: 10 holdout tasks support a go / no-go for a larger study, not a superiority claim. Reruns replace a task-arm row; they are not extra tasks.' };
}
