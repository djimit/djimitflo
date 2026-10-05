import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import type { LoopService } from './loop-service';
import { SkillEvolutionEngine } from './skill-evolution-engine';
import { mineGymTasks, type GymTask } from './gym-task-miner';
import { classifyHack, hackDetectorShadow } from './gym-hack-classifier';
import { evolveSpecies, parseSpecies, type Species } from './evolve-selection';

/**
 * C2b evolution gym runner (docs/design/evolution-gym.md). One attempt = one species on one replay task in a sandbox
 * worktree: reset to the commit, restore the parent version of the source (committed, so the maker's diff is its fix),
 * install deps, confirm the tests are red, run the maker, run the oracle. Success = tests green and only the source
 * changed. The outcome goes to skill_outcomes (domain 'gym'); nothing is pushed, reviewed or merged, so the maker's
 * approval is decided by the gym rule. EVOLUTION_GYM_ENABLED=true (default off), EVOLUTION_GYM_MAX_PER_DAY (default 12).
 */
/**
 * A species whose maker keeps failing at the provider (prod 2026-09-26/27: opencode + kimi-k2.6 hit 'Unexpected server
 * error' seven times in a row) never earns an outcome, so 'fewest outcomes goes next' kept picking it and starved every
 * other species. After 3 infra discards in 24 h a species sits out until the window passes.
 */
/**
 * Tasks a species should not be offered again: any non-infra attempt (success, failure or still running) or two infra
 * discards (prod 2026-09-29: task 9b2fa2bf crashed/timed out three times in a row on atomic@llama-router and, being
 * re-offered after each infra discard, tripped the breaker for the whole species).
 */
export function triedTasks(db: Database, speciesKey: string): Set<string | null> {
  return new Set((db.prepare(`SELECT c FROM (SELECT json_extract(metadata, '$.gym.commit') AS c,
      SUM(COALESCE(json_extract(metadata, '$.gym_result.reason'), '') NOT LIKE 'infra:%') AS real, SUM(json_extract(metadata, '$.gym_result.reason') LIKE 'infra:%') AS infra
    FROM loop_runs WHERE json_extract(metadata, '$.gym.species') = ? AND json_extract(metadata, '$.gym.canary') IS NULL GROUP BY c) WHERE real > 0 OR infra >= 2`).all(speciesKey) as Array<{ c: string | null }>).map((r) => r.c));
}

export function infraFailing(db: Database, speciesKey: string, since: string): boolean {
  // a success proves the species works: only discards after its latest success count (prod 2026-09-27: atomic@llama-router
  // was benched by three discards from since-fixed bugs, two of them before and after two successes)
  const lastSuccess = (db.prepare("SELECT MAX(created_at) AS t FROM loop_runs WHERE json_extract(metadata, '$.gym.species') = ? AND json_extract(metadata, '$.gym.canary') IS NULL AND json_extract(metadata, '$.gym_result.status') = 'success'")
    .get(speciesKey) as { t: string | null }).t;
  const from = lastSuccess && lastSuccess > since ? lastSuccess : since;
  const trips = db.prepare("SELECT COUNT(*) AS n, MAX(created_at) AS last FROM loop_runs WHERE json_extract(metadata, '$.gym.species') = ? AND json_extract(metadata, '$.gym.canary') IS NULL AND json_extract(metadata, '$.gym_result.reason') LIKE 'infra:%' AND created_at > ?")
    .get(speciesKey, from) as { n: number; last: string | null };
  if (trips.n < (Number(process.env.EVOLUTION_GYM_INFRA_TRIP) || 3)) return false;
  // half-open: after a quiet cool-down one probe attempt is let through (prod 2026-09-27: a fixed worker stayed benched for
  // the rest of the 24 h window); a new infra discard re-opens the breaker for another cool-down
  const coolDownMs = Number(process.env.EVOLUTION_GYM_BREAKER_RETRY_MS) || 2 * 3_600_000;
  return !trips.last || Date.now() - new Date(trips.last.replace(' ', 'T') + (/Z|[+-]\d\d:?\d\d$/.test(trips.last) ? '' : 'Z')).getTime() < coolDownMs;
}

export const gymEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.EVOLUTION_GYM_ENABLED === 'true';

export type GymResult = { status: 'success' | 'failure' | 'discarded' | 'skipped'; reason: string; task?: GymTask; species?: string; runId?: string; hack_flags?: string[] };

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

/** RX-11: the maker's diff for the hack classifier ('' when unavailable — the classifier then works from the file list). */
export function diffText(worktree: string): string {
  try { return git(worktree, ['diff', 'HEAD']).slice(0, 50_000); } catch { return ''; }
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
    // EVOLUTION_GYM_EXTRA_SPECIES: challengers that compete in the gym only, never on production goals (e.g. 'atomic', plan C5)
    return [{ runtime: env.LOOP_DAEMON_MAKER_RUNTIME || 'opencode' }, ...evolveSpecies({ ...env, LOOP_EVOLVE_ENABLED: 'true' }), ...parseSpecies(env.EVOLUTION_GYM_EXTRA_SPECIES)];
  }

  async runOne(now = new Date()): Promise<GymResult> {
    if (!gymEnabled()) return { status: 'skipped', reason: 'disabled' };
    const repo = process.env.LOOP_DAEMON_REPOSITORY_PATH;
    if (!repo) return { status: 'skipped', reason: 'no repository path' };
    const day = new Date(now.getTime() - 86_400_000).toISOString();
    // remote hosts (plan I1) have their own cap; only attempts on this VPS count here
    const today = (this.db.prepare("SELECT COUNT(*) AS n FROM skill_outcomes WHERE domain = 'gym' AND created_at >= ? AND COALESCE(evidence_refs_json, '') NOT LIKE '%\"remote:%'").get(day) as { n: number }).n;
    if (today >= (Number(process.env.EVOLUTION_GYM_MAX_PER_DAY) || 12)) return { status: 'skipped', reason: 'daily cap reached' };
    // production first: never compete with a running maker/reviewer
    const busy = (this.db.prepare("SELECT (SELECT COUNT(*) FROM worker_leases WHERE status = 'running') + (SELECT COUNT(*) FROM tasks WHERE status = 'running' AND id LIKE 'loop-worker-%') AS n").get() as { n: number }).n;
    if (busy > 0) return { status: 'skipped', reason: 'production workers running' };

    // the species with the fewest gym outcomes goes next, on the task it has attempted least recently
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM skill_outcomes WHERE domain = 'gym' AND skill_id = ? AND COALESCE(model, '') = ?");
    const keyOf = (s: Species) => (s.model ? `${s.runtime}@${s.model}` : s.runtime);
    const healthy = this.species().filter((s) => !infraFailing(this.db, keyOf(s), day));
    if (!healthy.length) return { status: 'skipped', reason: 'every species is infra-failing' };
    const species = healthy.map((s) => ({ s, n: (count.get(`loop-maker:gym:${s.runtime}`, s.model ?? '') as { n: number }).n })).sort((a, b) => a.n - b.n)[0].s;
    // every attempt (success, failure or discarded) is a gym loop_run for that species: never repeat one
    const key = species.model ? `${species.runtime}@${species.model}` : species.runtime;
    // an infra discard (provider error before the maker did anything) says nothing about the species: the task stays open (once)
    const tried = triedTasks(this.db, key);
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
    let makerRan = false;
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
        makerRan = true;
        await this.executeMaker(run.id, maker.id);
        const changed = this.deps.changed(maker.worktree_path);
        // prod 2026-09-25: an opencode provider error ('Unexpected server error', exit 1, 0 tokens) was scored as a species loss
        if (!changed.length && this.makerTokens(maker.id) === 0) {
          result = { status: 'discarded', reason: 'infra: maker produced nothing (0 tokens, no change)', task, species: key, runId: run.id };
          this.settle(run.id, result, maker.worktree_path, repo);
          return result;
        }
        const inScope = changed.length > 0 && changed.every((f) => f === task.source);
        const green = inScope && this.deps.oracle(maker.worktree_path, task);
        result = { status: green ? 'success' : 'failure', reason: green ? 'tests green, source only' : inScope ? 'tests still red' : `out of scope: ${changed.join(', ') || 'no change'}`, task, species: key, runId: run.id };
        if (hackDetectorShadow()) result.hack_flags = classifyHack({ changedFiles: changed, diffText: diffText(maker.worktree_path) });
      }
    } catch (err) {
      // an error before the maker ran (git, npm ci, worktree) says nothing about the species (prod 2026-09-27: 'git show
      // <commit>^:<file>' on a task whose source was new scored kimi-k3 and atomic as failures)
      const message = err instanceof Error ? err.message.slice(0, 190) : String(err);
      result = makerRan ? { status: 'failure', reason: message, task, species: key, runId: run.id } : { status: 'discarded', reason: `infra: ${message}`, task, species: key, runId: run.id };
    }
    if (result.status !== 'discarded') {
      const tokens = maker ? this.makerTokens(maker.id) : 0;
      new SkillEvolutionEngine(this.db).recordOutcome(`loop-maker:gym:${species.runtime}`, {
        success: result.status === 'success', tokensUsed: tokens, durationMs: Date.now() - started, domain: 'gym', taskId: run.id,
        ...(species.model ? { model: species.model } : {}), evidenceRefs: [`gym:${task.commit}`, `loop_run:${run.id}`, `gym_result:${result.reason}`],
      });
    }
    this.settle(run.id, result, maker?.worktree_path ?? null, repo);
    return result;
  }

  private makerTokens(leaseId: string): number {
    return Number((JSON.parse((this.db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(leaseId) as { metadata: string } | undefined)?.metadata || '{}') as { runtime_usage?: { total_tokens?: unknown } }).runtime_usage?.total_tokens) || 0;
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
      .run(now, JSON.stringify({ status: result.status, reason: result.reason, ...(result.hack_flags ? { hack_flags: result.hack_flags } : {}) }), runId);
    this.db.prepare("UPDATE worker_leases SET status = 'cancelled', updated_at = ? WHERE loop_run_id = ? AND status = 'prepared'").run(now, runId);
    if (worktree) { try { git(repo, ['worktree', 'remove', '--force', worktree]); } catch { fs.rmSync(worktree, { recursive: true, force: true }); } }
  }
}
