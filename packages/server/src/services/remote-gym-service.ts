import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { mineGymTasks, type GymTask } from './gym-task-miner';
import { parseSpecies } from './evolve-selection';
import { SkillEvolutionEngine } from './skill-evolution-engine';
import { infraFailing, triedTasks } from './evolution-gym-service';
import { mutantTask, type MutantTask } from './gym-mutants';
import { LoopEventService } from './loop-event-service';
import { changedFromReason, classifyHack, hackDetectorShadow } from './gym-hack-classifier';
import { settleNoHeadroom } from './dream-evolution';
import { FAILURE_TASK_CAPABILITY, failureDerivedTasks, gitLookup, gymFailureTasksEnabled, type TargetMutant } from './gym-failure-tasks';
import { daemonCheckOptions } from './loop-daemon';
import { dreamEvolutionEnabled, ensureBaseline, fireCheckVoid, genome, genomeFireCheck, holdout, mutantHoldout, mutantTrialsEnabled, nextTrialAttempt, parseFireCheck, type Genome } from './genome-registry';

/**
 * Plan I1: the evolution gym on a remote compute host (the workstation: 48 threads, 125 GB, R9700) instead of the
 * 2-core VPS. The host pulls work (no inbound port): claim → it replays the task in its own docker sandbox → result.
 * Only the score comes back; nothing is pushed, reviewed or merged, exactly like the local gym. Same never-repeat
 * bookkeeping (a loop_run per attempt, keyed by species), own daily cap. EVOLUTION_GYM_REMOTE_ENABLED=true (default off).
 */
export const remoteGymEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.EVOLUTION_GYM_REMOTE_ENABLED === 'true';
export const REMOTE_GYM_SCOPE = 'gym-worker';
/**
 * RX-5 (Phase F): difficulty probe. Every GYM_TIER_PROBE_EVERY-th ordinary claim (default 4 = 25 %) is a mutant-repair task
 * at a fixed tier from GYM_TIER_PROBE_TIERS (rotating), never a holdout key, tagged gym.probe so the adaptive tier and
 * readers can tell it apart. It measures pass rate per tier before anyone changes DREAM_TRIAL_MUTANT_TIERS.
 * GYM_TIER_PROBE_ENABLED=true (default off); trials keep priority and the daily cap counts probe claims.
 */
export function tierProbe(db: Database, env: NodeJS.ProcessEnv = process.env): number | null {
  if (env.GYM_TIER_PROBE_ENABLED !== 'true') return null;
  const tiers = String(env.GYM_TIER_PROBE_TIERS || '4,5,6').split(',').map(Number).filter((t) => Number.isInteger(t) && t >= 1 && t <= 8);
  const every = Math.max(1, Number(env.GYM_TIER_PROBE_EVERY) || 4);
  if (!tiers.length) return null;
  const n = (k: string) => { try { return (db.prepare(`SELECT COUNT(*) AS n FROM loop_runs WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym.canary') IS NULL ${k}`).get() as { n: number }).n; } catch { return 0; } };
  if ((n("AND json_extract(metadata, '$.gym.remote_host') IS NOT NULL") + 1) % every !== 0) return null;
  return tiers[n("AND json_extract(metadata, '$.gym.probe') = 1") % tiers.length];
}
const holdoutKeys = (db: Database): string[] => {
  try { return (db.prepare('SELECT commit_sha AS k FROM gym_holdout UNION SELECT key AS k FROM gym_mutant_holdout').all() as Array<{ k: string }>).map((r) => r.k); } catch { return []; }
};
/**
 * RX-11: a canary is a mutant task whose run also carries a test that no source-only change can turn green. A solved canary
 * means the oracle or the sandbox is compromised (stall 'gym:canary'). Served every round(1 / GYM_CANARY_RATE)-th claim
 * (default 0 = never) and ONLY to a worker that announces capabilities ['canary'] — today's worker would ignore the extra
 * test and 'solve' it. A canary earns no outcome, never marks its task tried and is left out of probe/trial bookkeeping.
 */
export const CANARY_TEST_PATH = 'packages/server/src/__tests__/gym-canary.test.ts';
const CANARY_TEST = "import { expect, it } from 'vitest';\n\nit('gym canary: unsolvable from the source file', () => { expect('canary').toBe('solved'); });\n";
function canaryDue(db: Database, capabilities: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  const rate = Number(env.GYM_CANARY_RATE) || 0;
  if (rate <= 0 || !capabilities.includes('canary')) return false;
  const every = Math.max(1, Math.round(1 / Math.min(1, rate)));
  try { return ((db.prepare("SELECT COUNT(*) AS n FROM loop_runs WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym.remote_host') IS NOT NULL").get() as { n: number }).n + 1) % every === 0; } catch { return false; }
}
const SAFE = /^[A-Za-z0-9._:/@-]{1,80}$/;

/**
 * Gym gold agreement (prod 2026-10-08): atomic@llama-router solved 7/9 gym write_test tasks mined from production failures
 * but 0/41 as a production maker — all 30 production regressions in 7 days were gate failures. The gym oracle (target test
 * green, source-only scope, a mutant killed) is a proxy; production also runs LOOP_DAEMON_CHECK_SCRIPTS and the lane diff
 * limit. GYM_PROD_GATES=true (default off) sends production's gate config with each claim to a worker announcing
 * capabilities ['prod_gates']; the worker runs those scripts on a proxy success and scores a failing gate as
 * 'prod_gate_failed:<check>'. Per-check results land in gym_result.prod_gates (evidence: proxy vs prod-gate success).
 */
export const gymProdGatesEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.GYM_PROD_GATES === 'true';
export const PROD_GATES_CAPABILITY = 'prod_gates';
/** Production's base maker diff limit (loop-daemon makerDiffMax for ordinary lanes; the worker raises it to 400 for a test-only change). */
export const PROD_GATE_DIFF_MAX = 200;
export interface ProdGatesConfig { scripts: string[]; timeout_ms: number; diff_max_lines: number }
export function prodGatesConfig(env: NodeJS.ProcessEnv = process.env): ProdGatesConfig {
  const opts = daemonCheckOptions(env);
  // runDeterministicChecks' own default is the repo-wide 'test', which never finishes; prod always sets the scoped list
  return { scripts: (opts.scripts ?? ['test:changed', 'lint', 'type-check']).filter((s) => /^[\w:.-]{1,40}$/.test(s)).slice(0, 8), timeout_ms: opts.timeout_ms, diff_max_lines: PROD_GATE_DIFF_MAX };
}
const GATE_STATUS = new Set(['pass', 'fail', 'skipped']);
/** Only a small {check: pass|fail|skipped} map is stored. */
export function sanitizeProdGates(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k, v]) => /^[\w:.-]{1,40}$/.test(k) && GATE_STATUS.has(String(v))).slice(0, 10).map(([k, v]) => [k, String(v)]));
  return Object.keys(out).length ? out : undefined;
}

export type RemoteGymClaim = { runId: string; species: string; task: GymTask; genome?: { id: string; lines: string[] }; prod_gates?: ProdGatesConfig } | { skipped: string };
export interface RemoteGymResult { status: 'success' | 'failure' | 'discarded'; reason: string; tokens?: number; durationMs?: number; changed_files?: unknown; diff?: unknown; killed_mutants?: unknown; prod_gates?: unknown; fire_check?: unknown }

export class RemoteGymService {
  private readonly outcomes: SkillEvolutionEngine;
  constructor(private readonly db: Database, private readonly mine: (repo: string) => GymTask[] = mineGymTasks) {
    this.outcomes = new SkillEvolutionEngine(db); // also ensures skill_outcomes exists before claim() counts it
  }

  claim(host: string, offered: string[], now = new Date(), opts: { capabilities?: string[] } = {}): RemoteGymClaim {
    if (!remoteGymEnabled()) return { skipped: 'disabled' };
    const repo = process.env.LOOP_DAEMON_REPOSITORY_PATH;
    if (!repo) return { skipped: 'no repository path' };
    if (!SAFE.test(host)) throw new Error('GYM_HOST_INVALID');
    const species = parseSpecies(offered.filter((s) => typeof s === 'string' && SAFE.test(s)).join(','), 8);
    if (!species.length) throw new Error('GYM_SPECIES_REQUIRED');
    // A host runs one attempt at a time (systemd oneshot), so its runs still 'running' at a new claim lost their report
    // (prod 2026-09-27: 'fetch failed' left f2df0beb running for good). Settle them as an infra discard — the task stays untried.
    this.db.prepare(`UPDATE loop_runs SET status = 'completed', updated_at = ?,
      metadata = json_set(metadata, '$.gym_result', json_object('status', 'discarded', 'reason', 'infra: worker lost the result (no report before its next claim)'))
      WHERE loop_name = 'evolution-gym' AND status = 'running' AND json_extract(metadata, '$.gym.remote_host') = ?`).run(now.toISOString(), host);
    const since = new Date(now.getTime() - 86_400_000).toISOString();
    const today = (this.db.prepare("SELECT COUNT(*) AS n FROM loop_runs WHERE json_extract(metadata, '$.gym.remote_host') IS NOT NULL AND created_at >= ?").get(since) as { n: number }).n;
    if (today >= (Number(process.env.EVOLUTION_GYM_REMOTE_MAX_PER_DAY) || 24)) return { skipped: 'daily cap reached' };
    // the offered species with the fewest gym outcomes goes next
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM skill_outcomes WHERE domain = 'gym' AND skill_id = ? AND COALESCE(model, '') = ?");
    const healthy = species.filter((s) => !infraFailing(this.db, s.model ? `${s.runtime}@${s.model}` : s.runtime, since));
    if (!healthy.length) return { skipped: 'every species is infra-failing' };
    const pick = healthy.map((s) => ({ s, n: (count.get(`loop-maker:gym:${s.runtime}`, s.model ?? '') as { n: number }).n })).sort((a, b) => a.n - b.n)[0].s;
    const key = pick.model ? `${pick.runtime}@${pick.model}` : pick.runtime;
    const tasks = this.mine(repo);
    // RX-5: the probe takes its share even while trials run (prod 05-10: trials take every claim for days, so a probe
    // behind them never ran); trials and ordinary replays share the rest
    let task: GymTask | undefined; let trialGenome: Genome | null = null; let probe = false; let canary = false;
    if (canaryDue(this.db, (opts.capabilities ?? []).map(String))) {
      const c = mutantTask(this.db, repo, key, new Set([...triedTasks(this.db, key), ...holdoutKeys(this.db)]));
      if (c) { task = { ...c, tests: [...c.tests, CANARY_TEST_PATH], canary: { test_path: CANARY_TEST_PATH, test_content: CANARY_TEST } } as GymTask; canary = true; }
    }
    const probeTier = task ? null : tierProbe(this.db);
    if (probeTier !== null) {
      const p = mutantTask(this.db, repo, key, new Set([...triedTasks(this.db, key), ...holdoutKeys(this.db)]), probeTier);
      if (p) { task = p; probe = true; }
    }
    // Y3: with dream evolution on, paired trial attempts on the frozen holdout come before normal replays
    if (!task && dreamEvolutionEnabled()) {
      ensureBaseline(this.db, now.toISOString());
      const mutants = mutantTrialsEnabled() ? mutantHoldout(this.db, (tier, tried) => mutantTask(this.db, repo, key, tried, tier), now.toISOString()) : [];
      const frozen = holdout(this.db, tasks, now.toISOString());
      settleNoHeadroom(this.db, key, frozen, mutants.map((m) => m.commit), now.getTime()); // B8: no mutant attempt on a trial nothing could win
      const next = nextTrialAttempt(this.db, key, [...frozen, ...mutants.map((m) => m.commit)]);
      if (next) { task = tasks.find((t) => t.commit === next.commit) ?? mutants.find((m) => m.commit === next.commit); trialGenome = task ? genome(this.db, next.genomeId) : null; }
      if (!trialGenome) task = undefined;
    }
    // Batch-8: a failure-derived 'write_test' task (real production failure) — only for a worker that can run one
    if (!task && gymFailureTasksEnabled() && (opts.capabilities ?? []).map(String).includes(FAILURE_TASK_CAPABILITY)) {
      const tried = triedTasks(this.db, key);
      task = this.failureTasks(repo).find((t) => !tried.has(t.commit));
    }
    if (!task) {
      const tried = triedTasks(this.db, key);
      // Y4: the mined fix commits run out (prod 2026-10-01) — then a seeded mutant-repair task keeps the gym supplied
      task = tasks.find((t) => !tried.has(t.commit)) ?? mutantTask(this.db, repo, key, tried) ?? undefined;
    }
    if (!task) return { skipped: 'no untried task' };
    const runId = randomUUID();
    const { mutant: _mutantContent, ...stored } = task as MutantTask; // the mutant goes to the worker, not into every row
    const { canary: _canaryTest, mutants, ...meta } = stored as typeof stored & { canary?: unknown; mutants?: TargetMutant[] };
    const gates = gymProdGatesEnabled() && (opts.capabilities ?? []).map(String).includes(PROD_GATES_CAPABILITY) ? prodGatesConfig() : null;
    const gymMeta = { ...meta, ...(mutants ? { mutant_keys: mutants.map((m) => m.key) } : {}), species: key, remote_host: host, ...(trialGenome ? { genome: trialGenome.id } : {}), ...(probe ? { probe: 1 } : {}), ...(canary ? { canary: 1 } : {}), ...(gates ? { prod_gates: 1 } : {}) };
    this.db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, repository_path, metadata, created_at, updated_at) VALUES (?, 'evolution-gym', 'closed', 'running', ?, ?, ?, ?)")
      .run(runId, repo, JSON.stringify({ gym: gymMeta }), now.toISOString(), now.toISOString());
    return { runId, species: key, task, ...(trialGenome ? { genome: { id: trialGenome.id, lines: trialGenome.lines } } : {}), ...(gates ? { prod_gates: gates } : {}) };
  }

  /** Injectable for tests; production reads the deploy checkout's git history. */
  failureTasks(repo: string) { return failureDerivedTasks(this.db, gitLookup(repo)); }

  record(runId: string, host: string, result: RemoteGymResult): void {
    const row = this.db.prepare("SELECT status, json_extract(metadata, '$.gym') AS gym FROM loop_runs WHERE id = ?").get(runId) as { status: string; gym: string | null } | undefined;
    const gym = row?.gym ? JSON.parse(row.gym) as GymTask & { species: string; remote_host?: string; genome?: string; probe?: number; canary?: number; mutant_keys?: string[]; prod_gates?: number } : null;
    if (!row || !gym || gym.remote_host !== host) throw new Error('GYM_RUN_NOT_FOUND');
    if (row.status !== 'running') throw new Error('GYM_RUN_ALREADY_SETTLED');
    if (!['success', 'failure', 'discarded'].includes(result.status)) throw new Error('GYM_RESULT_INVALID');
    const reason = String(result.reason || '').slice(0, 200);
    // GENOME_FIRE_CHECK: a trial attempt without proof that the genome's lines reached the maker is VOID (genome-registry)
    const fire_check = genomeFireCheck() ? parseFireCheck(result.fire_check) : null;
    const voided = genomeFireCheck() ? fireCheckVoid(this.db, gym.genome, result.status, fire_check) : null;
    if (result.status !== 'discarded' && !gym.canary && !voided) {
      const [species] = parseSpecies(gym.species, 1);
      this.outcomes.recordOutcome(`loop-maker:gym:${species.runtime}`, {
        success: result.status === 'success', tokensUsed: Math.max(0, Number(result.tokens) || 0), durationMs: Math.max(0, Number(result.durationMs) || 0), domain: 'gym', taskId: runId,
        ...(species.model ? { model: species.model } : {}), evidenceRefs: [`gym:${gym.commit}`, `loop_run:${runId}`, `gym_result:${reason}`, `remote:${host}`, ...(gym.genome ? [`genome:${gym.genome}`] : []), ...(gym.probe ? ['gym:probe'] : []), ...((gym as { kind?: string }).kind === 'write_test' ? ['gym:fail'] : [])],
      });
    }
    let hack_flags: string[] | undefined;
    if (hackDetectorShadow() && result.status !== 'discarded') {
      const files = Array.isArray(result.changed_files) ? result.changed_files.map(String).slice(0, 50) : changedFromReason(reason);
      hack_flags = classifyHack({ changedFiles: files, diffText: typeof result.diff === 'string' ? result.diff.slice(0, 50_000) : '', reason });
      // a 'write_test' task asks the maker to write the test file: touching it is the task, not a hack
      if ((gym as { kind?: string }).kind === 'write_test') hack_flags = hack_flags.filter((f) => f !== 'tests_touched');
      if (hack_flags.length) {
        try { new LoopEventService(this.db).recordEvent(runId, 'gym_hack_shadow', 'warning', `Gym hack flags (shadow): ${hack_flags.join(', ')}`, { species: gym.species, flags: hack_flags, status: result.status }); } catch { /* never break the report */ }
      }
    }
    // B8: which of the served mutants the write_test maker's test killed (only keys the server handed out)
    const killed_mutants = Array.isArray(gym.mutant_keys) && Array.isArray(result.killed_mutants) ? result.killed_mutants.map(String).filter((k) => gym.mutant_keys!.includes(k)) : undefined;
    // gym gold agreement: the per-check production gate results of a proxy success (only on a run claimed with the gates)
    const prod_gates = gym.prod_gates ? sanitizeProdGates(result.prod_gates) : undefined;
    const now = new Date().toISOString();
    this.db.prepare("UPDATE loop_runs SET status = 'completed', updated_at = ?, metadata = json_set(metadata, '$.gym_result', json(?)) WHERE id = ?")
      .run(now, JSON.stringify({ status: result.status, reason, ...(hack_flags ? { hack_flags } : {}), ...(killed_mutants ? { killed_mutants } : {}),
        ...(prod_gates ? { prod_gates } : {}),
        ...(fire_check ? { fire_check } : {}), ...(voided ? { void: voided } : {}) }), runId);
  }
}
