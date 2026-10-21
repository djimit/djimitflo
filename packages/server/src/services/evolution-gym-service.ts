import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import type { LoopService } from './loop-service';
import { SkillEvolutionEngine } from './skill-evolution-engine';
import { mineGymTasks, type GymTask } from './gym-task-miner';
import { classifyHack, hackDetectorShadow } from './gym-hack-classifier';
import { evolveSpecies, parseSpecies, type Species } from './evolve-selection';
import { markRun } from './scheduler-registry';
import { gymSkillContentHash } from './gym-skill-hash';
import { recordModelCall } from './model-selector';
import { AUTH_MISSING, LIMIT_HIT, inLimitBackoff, isSubscriptionLimit, subscriptionAttemptsToday, subscriptionAuthPresent, subscriptionGymMaxPerDay,
  subscriptionGymSpecies, type SubscriptionRuntime } from './subscription-gym';
import { CANCEL_LEASE_METADATA_SQL, cancelLeaseBind } from './lease-failure';

const speciesKey = (s: Species): string => (s.model ? `${s.runtime}@${s.model}` : s.runtime);

/** A gym species; `subscription` = a flat-subscription CLI maker (SUBSCRIPTION_GYM_SPECIES, services/subscription-gym.ts). */
export type GymSpecies = Species & { subscription?: true };

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
      SUM(COALESCE(json_extract(metadata, '$.gym_result.reason'), '') NOT LIKE 'infra:%') AS real,
      SUM(json_extract(metadata, '$.gym_result.reason') LIKE 'infra:%' AND json_extract(metadata, '$.gym_result.reason') NOT LIKE 'infra: subscription_%') AS infra
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
/** The local gym runs when it is enabled or when subscription species are set (those alone, then). */
export const gymArmed = (env: NodeJS.ProcessEnv = process.env): boolean => gymEnabled(env) || subscriptionGymSpecies(env).length > 0;

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
    if (this.timer || !gymArmed()) return;
    const run = () => { markRun('evolution_gym'); this.runOne().then((r) => { if (r.status !== 'skipped') console.log(`🏋️ gym: ${r.status} (${r.reason}) ${r.species ?? ''} ${r.task?.source ?? ''}`); }).catch((err) => console.warn('Gym attempt failed:', err instanceof Error ? err.message : String(err))); };
    this.timer = setInterval(run, intervalMs); this.timer.unref?.();
    // auto-deploy restarts the server every hour or two: waiting a full interval after boot would starve the gym
    setTimeout(run, Number(process.env.EVOLUTION_GYM_FIRST_DELAY_MS) || 600_000).unref?.();
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /**
   * Incumbent maker runtime plus the evolve challengers: every species gets the same tasks. SUBSCRIPTION_GYM_SPECIES adds the
   * subscription CLIs (alone while EVOLUTION_GYM_ENABLED is off); a configured species on the same runtime gives way to them,
   * so a claude/codex gym maker never bills an API key. An opencode-free species (runtime opencode, model opencode/<x>-free)
   * replaces only a configured species with that same model, never the plain opencode species.
   */
  species(env: NodeJS.ProcessEnv = process.env): GymSpecies[] {
    const subs = subscriptionGymSpecies(env);
    // EVOLUTION_GYM_EXTRA_SPECIES: challengers that compete in the gym only, never on production goals (e.g. 'atomic', plan C5)
    const base: Species[] = gymEnabled(env) ? [{ runtime: env.LOOP_DAEMON_MAKER_RUNTIME || 'opencode' }, ...evolveSpecies({ ...env, LOOP_EVOLVE_ENABLED: 'true' }), ...parseSpecies(env.EVOLUTION_GYM_EXTRA_SPECIES)] : [];
    const replaced = (s: Species) => subs.some((sub) => (sub.model ? speciesKey(s) === sub.key : s.runtime === sub.runtime));
    return [...base.filter((s) => !replaced(s)), ...subs.map((sub) => ({ runtime: sub.runtime, ...(sub.model ? { model: sub.model } : {}), subscription: true as const }))];
  }

  async runOne(now = new Date()): Promise<GymResult> {
    if (!gymArmed()) return { status: 'skipped', reason: 'disabled' };
    const repo = process.env.LOOP_DAEMON_REPOSITORY_PATH;
    if (!repo) return { status: 'skipped', reason: 'no repository path' };
    const day = new Date(now.getTime() - 86_400_000).toISOString();
    // remote hosts (plan I1) have their own cap; only attempts on this VPS count here. Subscription species have their own
    // per-species cap (SUBSCRIPTION_GYM_MAX_PER_DAY, attempts) and stay out of this one.
    const subs = subscriptionGymSpecies();
    const today = (this.db.prepare(`SELECT COUNT(*) AS n FROM skill_outcomes WHERE domain = 'gym' AND created_at >= ? AND COALESCE(evidence_refs_json, '') NOT LIKE '%"remote:%'
      AND skill_id || '|' || COALESCE(model, '') NOT IN (SELECT value FROM json_each(?))`).get(day, JSON.stringify(subs.map((r) => `loop-maker:gym:${r.runtime}|${r.model ?? ''}`))) as { n: number }).n;
    const capped = today >= (Number(process.env.EVOLUTION_GYM_MAX_PER_DAY) || 12);
    let backingOff = false;
    const open = this.species().filter((s) => {
      if (!s.subscription) return !capped;
      if (subscriptionAttemptsToday(this.db, speciesKey(s), now.getTime()) >= subscriptionGymMaxPerDay()) return false;
      if (inLimitBackoff(this.db, speciesKey(s), now.getTime())) { backingOff = true; return false; }
      return true;
    });
    if (!open.length) return { status: 'skipped', reason: backingOff ? 'subscription limit back-off' : 'daily cap reached' };
    // production first: never compete with a running maker/reviewer
    const busy = (this.db.prepare("SELECT (SELECT COUNT(*) FROM worker_leases WHERE status = 'running') + (SELECT COUNT(*) FROM tasks WHERE status = 'running' AND id LIKE 'loop-worker-%') AS n").get() as { n: number }).n;
    if (busy > 0) return { status: 'skipped', reason: 'production workers running' };

    // the species with the fewest gym outcomes goes next, on the task it has attempted least recently
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM skill_outcomes WHERE domain = 'gym' AND skill_id = ? AND COALESCE(model, '') = ?");
    const healthy = open.filter((s) => !infraFailing(this.db, speciesKey(s), day));
    if (!healthy.length) return { status: 'skipped', reason: 'every species is infra-failing' };
    const species = healthy.map((s) => ({ s, n: (count.get(`loop-maker:gym:${s.runtime}`, s.model ?? '') as { n: number }).n })).sort((a, b) => a.n - b.n)[0].s;
    // every attempt (success, failure or discarded) is a gym loop_run for that species: never repeat one
    const key = speciesKey(species);
    // an infra discard (provider error before the maker did anything) says nothing about the species: the task stays open (once)
    const tried = triedTasks(this.db, key);
    const task = this.deps.mine(repo).find((t) => !tried.has(t.commit));
    if (!task) return { status: 'skipped', reason: 'no untried task' };
    return this.attempt(repo, task, species);
  }

  async attempt(repo: string, task: GymTask, species: GymSpecies): Promise<GymResult> {
    const key = speciesKey(species);
    const run = this.loops.startLoop({ repository_path: repo, target_finding: { file_path: task.source, category: 'bug',
      description: `Evolution gym: make ${task.tests.join(', ')} pass. Change only ${task.source}. The tests describe the intended behaviour; do not edit them.` } });
    this.db.prepare("UPDATE loop_runs SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.gym', json(?)) WHERE id = ?").run(JSON.stringify({ ...task, species: key, ...(species.subscription ? { subscription: 1 } : {}) }), run.id);
    // a subscription maker without its login is never spawned: the CLI could otherwise only fail or bill elsewhere
    if (species.subscription && !subscriptionAuthPresent(species.runtime as SubscriptionRuntime)) {
      const refused: GymResult = { status: 'discarded', reason: AUTH_MISSING, task, species: key, runId: run.id };
      this.settle(run.id, refused, null, repo);
      return refused;
    }
    const started = Date.now();
    let result: GymResult;
    let maker: { id: string; worktree_path: string | null } | undefined;
    let makerRan = false;
    let limited: boolean | null = null; // subscription species: set once the maker's usage is recorded
    try {
      const { leases } = this.loops.continueLoopRun(run.id, { runtime: species.runtime as never, ...(species.model ? { model: species.model } : {}), max_maker_workers: 1 });
      maker = leases.find((l) => l.role === 'maker');
      if (!maker?.worktree_path) throw new Error('no maker worktree');
      if (species.subscription) this.db.prepare("UPDATE worker_leases SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.subscription_auth', ?) WHERE id = ?").run(species.runtime, maker.id);
      this.deps.prepare(maker.worktree_path, task);
      const discard = !this.deps.install(maker.worktree_path) ? 'npm ci failed'
        : this.deps.oracle(maker.worktree_path, task) ? 'tests already green on the parent' : null;
      if (discard) {
        result = { status: 'discarded', reason: discard, task, species: key, runId: run.id };
      } else {
        makerRan = true;
        await this.executeMaker(run.id, maker.id);
        // a rate/usage limit says nothing about the species: discard (no outcome) and back off (inLimitBackoff)
        if (species.subscription && (limited = this.subscriptionMakerRan(run.id, maker.id, species))) {
          result = { status: 'discarded', reason: LIMIT_HIT, task, species: key, runId: run.id };
          this.settle(run.id, result, maker.worktree_path, repo);
          return result;
        }
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
      result = makerRan && species.subscription && maker && (limited ?? this.subscriptionMakerRan(run.id, maker.id, species)) ? { status: 'discarded', reason: LIMIT_HIT, task, species: key, runId: run.id }
        : makerRan ? { status: 'failure', reason: message, task, species: key, runId: run.id } : { status: 'discarded', reason: `infra: ${message}`, task, species: key, runId: run.id };
    }
    if (result.status !== 'discarded') {
      const tokens = maker ? this.makerTokens(maker.id) : 0;
      new SkillEvolutionEngine(this.db).recordOutcome(`loop-maker:gym:${species.runtime}`, {
        success: result.status === 'success', tokensUsed: tokens, durationMs: Date.now() - started, domain: 'gym', taskId: run.id, skillContentHash: gymSkillContentHash((task as { kind?: string }).kind, null),
        ...(species.model ? { model: species.model } : {}), evidenceRefs: [`gym:${task.commit}`, `loop_run:${run.id}`, `gym_result:${result.reason}`],
      });
    }
    this.settle(run.id, result, maker?.worktree_path ?? null, repo);
    return result;
  }

  /**
   * After a subscription maker ran: what the CLI reported goes to llm_model_calls as a flat subscription (provider
   * `subscription-cli:<runtime>`) or, for an opencode-free species, the Zen free tier (provider `free-tier-cli:opencode`);
   * marginal cost 0 either way, unreported counts stay null. Returns whether the run hit the
   * subscription's rate/usage limit. Reads the lease's recorded outputs; never the token.
   */
  private subscriptionMakerRan(runId: string, leaseId: string, species: GymSpecies): boolean {
    const runtime = species.runtime;
    const freeTier = runtime === 'opencode'; // the only opencode subscription species are opencode-free:<model>
    const meta = JSON.parse((this.db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(leaseId) as { metadata: string } | undefined)?.metadata || '{}') as {
      exit_status?: number | null; stdout_path?: string; stderr_path?: string; failure_reason?: string;
      token_accounting?: { input_tokens?: number | null; output_tokens?: number | null; model_id?: string | null; duration_ms?: number | null } };
    if (meta.exit_status === undefined && !meta.stdout_path && !meta.failure_reason) return false; // the maker never ran
    const read = (p?: string) => { try { return p ? fs.readFileSync(p, 'utf8') : ''; } catch { return ''; } };
    const stdout = read(meta.stdout_path); const stderr = `${read(meta.stderr_path)}\n${meta.failure_reason ?? ''}`;
    const limited = isSubscriptionLimit(meta.exit_status ?? null, stdout, stderr);
    // claude -p --output-format json reports its own duration_ms; else the server's wall clock around the call
    let cliMs: number | null = null;
    for (const line of stdout.split('\n').reverse()) {
      if (!line.includes('"duration_ms"')) continue;
      try { const v = JSON.parse(line.trim()) as { duration_ms?: unknown }; if (typeof v.duration_ms === 'number') { cliMs = v.duration_ms; break; } } catch { /* not a JSON line */ }
    }
    const t = meta.token_accounting ?? {};
    recordModelCall(this.db, { consumer: 'evolution_gym', model: t.model_id || species.model || `${runtime}-cli`,
      provider: freeTier ? 'free-tier-cli:opencode' : `subscription-cli:${runtime}`, ok: meta.exit_status === 0,
      latencyMs: cliMs ?? t.duration_ms ?? 0, outChars: stdout.length, shadow: 0, agree: null, tokensIn: t.input_tokens ?? null, tokensOut: t.output_tokens ?? null,
      taskKind: 'gym_maker', runId, status: limited ? 'subscription_limit' : meta.exit_status === 0 ? 'ok' : `exit_${meta.exit_status ?? 'signal'}`,
      purpose: freeTier ? 'evolution_gym:free_tier_maker' : 'evolution_gym:subscription_maker' });
    return limited;
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
    this.db.prepare(`UPDATE worker_leases SET status = 'cancelled', updated_at = ?, ${CANCEL_LEASE_METADATA_SQL} WHERE loop_run_id = ? AND status = 'prepared'`).run(now, ...cancelLeaseBind('gym_run_settled', now), runId);
    if (worktree) { try { git(repo, ['worktree', 'remove', '--force', worktree]); } catch { fs.rmSync(worktree, { recursive: true, force: true }); } }
  }
}
