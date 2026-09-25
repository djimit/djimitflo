import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import type { LoopService } from './loop-service';
import { SkillEvolutionEngine } from './skill-evolution-engine';
import { mineGymTasks, type GymTask } from './gym-task-miner';
import { evolveSpecies, type Species } from './evolve-selection';

/**
 * C2b evolution gym runner (docs/design/evolution-gym.md). One attempt = one species on one replay task in a sandbox
 * worktree: reset to the commit, restore the parent version of the source (committed, so the maker's diff is its fix),
 * install deps, confirm the tests are red, run the maker, run the oracle. Success = tests green and only the source
 * changed. The outcome goes to skill_outcomes (domain 'gym'); nothing is pushed, reviewed or merged, so the maker's
 * approval is decided by the gym rule. EVOLUTION_GYM_ENABLED=true (default off), EVOLUTION_GYM_MAX_PER_DAY (default 12).
 */
export const gymEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.EVOLUTION_GYM_ENABLED === 'true';

export type GymResult = { status: 'success' | 'failure' | 'discarded' | 'skipped'; reason: string; task?: GymTask; species?: string; runId?: string };

const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Puts a worktree into the task's broken state: the commit, with the source file restored to its parent (committed). */
export function prepareGymWorktree(worktree: string, task: GymTask): void {
  git(worktree, ['reset', '--hard', task.commit]);
  fs.writeFileSync(path.join(worktree, task.source), git(worktree, ['show', `${task.commit}^:${task.source}`]));
  git(worktree, ['-c', 'user.email=gym@djimitflo', '-c', 'user.name=djimitflo-gym', 'commit', '-qam', `gym: restore parent of ${task.source}`]);
}

/** The oracle: the commit's tests, run from packages/server. */
export function runOracle(worktree: string, task: GymTask, timeoutMs = 300_000): boolean {
  const tests = task.tests.map((t) => t.replace(/^packages\/server\//, ''));
  const r = spawnSync('npx', ['vitest', 'run', ...tests], { cwd: path.join(worktree, 'packages/server'), timeout: timeoutMs, stdio: 'ignore' });
  return r.status === 0;
}

export function changedFiles(worktree: string): string[] {
  return [...git(worktree, ['diff', '--name-only', 'HEAD']).split('\n'), ...git(worktree, ['ls-files', '--others', '--exclude-standard']).split('\n')]
    .filter((f) => f && !f.startsWith('.djimitflo/') && f !== 'package-lock.json');
}

export class EvolutionGymService {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly db: Database, private readonly loops: LoopService, private readonly deps = {
    mine: mineGymTasks, prepare: prepareGymWorktree, install: (wt: string) => spawnSync('npm', ['ci', '--legacy-peer-deps', '--no-audit', '--no-fund'], { cwd: wt, timeout: 600_000, stdio: 'ignore' }).status === 0,
    oracle: runOracle, changed: changedFiles,
  }) { new SkillEvolutionEngine(db); } // ensures skill_outcomes exists (created lazily elsewhere)

  start(intervalMs = 3_600_000): void {
    if (this.timer || !gymEnabled()) return;
    const run = () => { this.runOne().then((r) => { if (r.status !== 'skipped') console.log(`🏋️ gym: ${r.status} (${r.reason}) ${r.species ?? ''} ${r.task?.source ?? ''}`); }).catch((err) => console.warn('Gym attempt failed:', err instanceof Error ? err.message : String(err))); };
    this.timer = setInterval(run, intervalMs); this.timer.unref?.();
    // auto-deploy restarts the server every hour or two: waiting a full interval after boot would starve the gym
    setTimeout(run, Number(process.env.EVOLUTION_GYM_FIRST_DELAY_MS) || 600_000).unref?.();
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /** Incumbent maker runtime plus the evolve challengers: every species gets the same tasks. */
  species(env: NodeJS.ProcessEnv = process.env): Species[] {
    return [{ runtime: env.LOOP_DAEMON_MAKER_RUNTIME || 'opencode' }, ...evolveSpecies({ ...env, LOOP_EVOLVE_ENABLED: 'true' })];
  }

  async runOne(now = new Date()): Promise<GymResult> {
    if (!gymEnabled()) return { status: 'skipped', reason: 'disabled' };
    const repo = process.env.LOOP_DAEMON_REPOSITORY_PATH;
    if (!repo) return { status: 'skipped', reason: 'no repository path' };
    const day = new Date(now.getTime() - 86_400_000).toISOString();
    const today = (this.db.prepare("SELECT COUNT(*) AS n FROM skill_outcomes WHERE domain = 'gym' AND created_at >= ?").get(day) as { n: number }).n;
    if (today >= (Number(process.env.EVOLUTION_GYM_MAX_PER_DAY) || 12)) return { status: 'skipped', reason: 'daily cap reached' };
    // production first: never compete with a running maker/reviewer
    const busy = (this.db.prepare("SELECT (SELECT COUNT(*) FROM worker_leases WHERE status = 'running') + (SELECT COUNT(*) FROM tasks WHERE status = 'running' AND id LIKE 'loop-worker-%') AS n").get() as { n: number }).n;
    if (busy > 0) return { status: 'skipped', reason: 'production workers running' };

    // the species with the fewest gym outcomes goes next, on the task it has attempted least recently
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM skill_outcomes WHERE domain = 'gym' AND skill_id = ? AND COALESCE(model, '') = ?");
    const species = this.species().map((s) => ({ s, n: (count.get(`loop-maker:gym:${s.runtime}`, s.model ?? '') as { n: number }).n })).sort((a, b) => a.n - b.n)[0].s;
    // every attempt (success, failure or discarded) is a gym loop_run for that species: never repeat one
    const key = species.model ? `${species.runtime}@${species.model}` : species.runtime;
    const tried = new Set((this.db.prepare("SELECT json_extract(metadata, '$.gym.commit') AS c FROM loop_runs WHERE json_extract(metadata, '$.gym.species') = ?")
      .all(key) as Array<{ c: string | null }>).map((r) => r.c));
    const task = this.deps.mine(repo).find((t) => !tried.has(t.commit));
    if (!task) return { status: 'skipped', reason: 'no untried task' };
    return this.attempt(repo, task, species);
  }

  async attempt(repo: string, task: GymTask, species: Species): Promise<GymResult> {
    const key = species.model ? `${species.runtime}@${species.model}` : species.runtime;
    const run = this.loops.startLoop({ repository_path: repo, target_finding: { file_path: task.source, category: 'bug',
      description: `Evolution gym: make ${task.tests.join(', ')} pass. Change only ${task.source}. The tests describe the intended behaviour; do not edit them.` } });
    this.db.prepare("UPDATE loop_runs SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.gym', json(?)) WHERE id = ?").run(JSON.stringify({ ...task, species: key }), run.id);
    const started = Date.now();
    let result: GymResult;
    let maker: { id: string; worktree_path: string | null } | undefined;
    try {
      const { leases } = this.loops.continueLoopRun(run.id, { runtime: species.runtime as never, ...(species.model ? { model: species.model } : {}), max_maker_workers: 1 });
      maker = leases.find((l) => l.role === 'maker');
      if (!maker?.worktree_path) throw new Error('no maker worktree');
      this.deps.prepare(maker.worktree_path, task);
      const discard = !this.deps.install(maker.worktree_path) ? 'npm ci failed'
        : this.deps.oracle(maker.worktree_path, task) ? 'tests already green on the parent' : null;
      if (discard) {
        result = { status: 'discarded', reason: discard, task, species: key, runId: run.id };
      } else {
        await this.executeMaker(run.id, maker.id);
        const changed = this.deps.changed(maker.worktree_path);
        const inScope = changed.length > 0 && changed.every((f) => f === task.source);
        const green = inScope && this.deps.oracle(maker.worktree_path, task);
        result = { status: green ? 'success' : 'failure', reason: green ? 'tests green, source only' : inScope ? 'tests still red' : `out of scope: ${changed.join(', ') || 'no change'}`, task, species: key, runId: run.id };
      }
    } catch (err) {
      result = { status: 'failure', reason: err instanceof Error ? err.message.slice(0, 200) : String(err), task, species: key, runId: run.id };
    }
    if (result.status !== 'discarded') {
      const tokens = maker ? Number((JSON.parse((this.db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(maker.id) as { metadata: string } | undefined)?.metadata || '{}') as { runtime_usage?: { total_tokens?: unknown } }).runtime_usage?.total_tokens) || 0 : 0;
      new SkillEvolutionEngine(this.db).recordOutcome(`loop-maker:gym:${species.runtime}`, {
        success: result.status === 'success', tokensUsed: tokens, durationMs: Date.now() - started, domain: 'gym', taskId: run.id,
        ...(species.model ? { model: species.model } : {}), evidenceRefs: [`gym:${task.commit}`, `loop_run:${run.id}`, `gym_result:${result.reason}`],
      });
    }
    this.settle(run.id, result, maker?.worktree_path ?? null, repo);
    return result;
  }

  /** The maker needs an approval like any maker; in the gym nothing leaves the sandbox, so the gym rule decides it. */
  private async executeMaker(runId: string, leaseId: string): Promise<void> {
    const input = { lease_id: leaseId, timeout_ms: 600_000, diff_max_lines: 200, skip_permissions: Boolean(process.env.RUNTIME_ALLOW_SKIP_PERMISSIONS) };
    try { await this.loops.executeWorker(runId, input); return; } catch (err) {
      if (!/APPROVAL_REQUIRED/.test(err instanceof Error ? err.message : String(err))) throw err;
    }
    const meta = JSON.parse((this.db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(leaseId) as { metadata: string }).metadata || '{}') as { approval_id?: string; execution_task_id?: string };
    const approvalId = meta.approval_id ?? (meta.execution_task_id
      ? (this.db.prepare("SELECT id FROM approvals WHERE task_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(meta.execution_task_id) as { id: string } | undefined)?.id
      : undefined);
    if (!approvalId) throw new Error('gym maker approval not found');
    await this.loops.decideWorkerApproval(approvalId, true, 'autonomy:gym-rule-v1', 'evolution gym sandbox: nothing is pushed, reviewed or merged');
    await this.loops.awaitWorkerExecution(leaseId);
    await this.loops.executeWorker(runId, input);
  }

  /** The run is bookkeeping: settle it so it is never replayed as a failure, cancel reviewer leases, drop the worktree. */
  private settle(runId: string, result: GymResult, worktree: string | null, repo: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE loop_runs SET status = 'completed', updated_at = ?, metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.gym_result', json(?)) WHERE id = ?`)
      .run(now, JSON.stringify({ status: result.status, reason: result.reason }), runId);
    this.db.prepare("UPDATE worker_leases SET status = 'cancelled', updated_at = ? WHERE loop_run_id = ? AND status = 'prepared'").run(now, runId);
    if (worktree) { try { git(repo, ['worktree', 'remove', '--force', worktree]); } catch { fs.rmSync(worktree, { recursive: true, force: true }); } }
  }
}
