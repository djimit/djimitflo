import { createHash, randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { Database } from 'better-sqlite3';
import { mineGymTasks, minedTaskAt, type GymTask } from './gym-task-miner';
import { parseSpecies } from './evolve-selection';
import { SkillEvolutionEngine } from './skill-evolution-engine';
import { infraFailing, triedTasks } from './evolution-gym-service';
import { mutantTask, type MutantTask } from './gym-mutants';
import { LoopEventService } from './loop-event-service';
import { recordEffortGym } from './effort-controller';
import { changedFromReason, classifyHack, hackDetectorShadow } from './gym-hack-classifier';
import { settleNoHeadroom } from './dream-evolution';
import { FAILURE_TASK_CAPABILITY, failureDerivedTasks, gitLookup, gymFailureTasksEnabled, type TargetMutant } from './gym-failure-tasks';
import { daemonCheckOptions } from './loop-daemon';
import { redactSecrets } from './secret-patterns';
import { remoteGymCap } from './stall-watch';
import { gymSkillContentHash } from './gym-skill-hash';
import { gradedFitnessMode, gradedRefs, roundGraded, type GradedKind } from './graded-fitness';
import { TG_CAPABILITY, TG_GENERATION, TG_ID, TG_LOOP, claimTg001, freezeTg001, recordTg001, tg001On, tgManifest } from './tg-001';
import { PROCEDURE_ID, procedureSelectorMode, recordProcedureSelection } from './procedure-selector';
import { PL_ID, PL_LOOP, PL_MUTANT_TIERS, PL_REQUIRED_CAPABILITIES, PL_SPECIES, applyPl001Lifecycle, claimPl001, freezePl001, lastPlFreezeRefusal, pl001On, plClaimMeta,
  plClaims24h, plManifest, plResult, plStartCondition, plState, plTaskKeys, plVoid, recordPl001, recordPlFreezeRefusal, type PlClaimMeta, type PlManifest } from './pl-001';
import { dreamEvolutionEnabled, ensureBaseline, fireCheckVoid, genome, genomeFireCheck, holdout, mutantHoldout, mutantTrialsEnabled, nextTrialAttempt, parseFireCheck, writeTestHoldout, writeTestHoldoutEnabled, type Genome } from './genome-registry';

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
  let keys: string[] = [];
  try { keys = (db.prepare('SELECT commit_sha AS k FROM gym_holdout UNION SELECT key AS k FROM gym_mutant_holdout UNION SELECT key AS k FROM gym_write_test_holdout UNION SELECT task_key AS k FROM tg_attempts').all() as Array<{ k: string }>).map((r) => r.k); } catch { return []; }
  // PL-001: a frozen task is reserved for the experiment (both arms), never served as ordinary gym work
  const pl = plTaskKeys(db);
  return pl.size ? [...keys, ...[...pl].filter((k) => !keys.includes(k))] : keys;
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
const gitHead = (repo: string): string | null => { try { return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim() || null; } catch { return null; } };
/** TG-001 manifest: the worker version the experiment is frozen against = sha256 of scripts/gym-worker.mjs in the deploy checkout. */
const harnessHash = (repo: string): string | null => { try { return `scripts/gym-worker.mjs@sha256:${createHash('sha256').update(fs.readFileSync(path.join(repo, 'scripts/gym-worker.mjs'))).digest('hex')}`; } catch { return null; } };

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

/**
 * SI-A gym graded score (GRADED_FITNESS_MODE=shadow): write_test = served mutants the test killed / served mutants, counted
 * here from the keys this server handed out; repair = the worker's per-test share (tests_green) or its 1/0 (binary); a
 * missing or invalid worker value falls back to binary from the verdict (an older worker).
 */
export function gymGraded(gym: { kind?: string; mutant_keys?: string[] }, result: RemoteGymResult, killed?: string[]): { graded: number; graded_kind: GradedKind } {
  if (gym.kind === 'write_test' && gym.mutant_keys?.length) return { graded: roundGraded((killed?.length ?? 0) / gym.mutant_keys.length), graded_kind: 'mutant_kill' };
  const g = Number(result.graded);
  if ((result.graded_kind === 'tests_green' || result.graded_kind === 'binary') && typeof result.graded === 'number' && g >= 0 && g <= 1) return { graded: roundGraded(g), graded_kind: result.graded_kind };
  return { graded: result.status === 'success' ? 1 : 0, graded_kind: 'binary' };
}

/**
 * GYM_STORE_DIFFS=true (default off, Phase SOUP baseline 09-10: 0 stored (task, diff, oracle result) pairs): the diff of
 * every scored attempt (success or failure, never a discard) goes to gym_attempt_diffs — secret-redacted with the
 * diff-capture patterns (redactSecrets), then capped at GYM_DIFF_MAX_BYTES, with the sha256 of what was stored.
 * gym_result.diff_ref = 'sha256:<hex>' links the run to it; loop_runs.metadata never carries the diff itself.
 */
export const gymStoreDiffs = (env: NodeJS.ProcessEnv = process.env): boolean => env.GYM_STORE_DIFFS === 'true';
export const GYM_DIFF_MAX_BYTES = 50_000;
export function prepareGymDiff(raw: string): { diff: string; sha256: string; redacted: number; truncated: boolean } {
  // redact before the cap, so a cut never leaves half a secret the patterns no longer match
  const { redacted: text, count } = redactSecrets(raw.slice(0, 4 * GYM_DIFF_MAX_BYTES));
  const bytes = Buffer.from(text, 'utf8');
  const truncated = bytes.length > GYM_DIFF_MAX_BYTES || raw.length > 4 * GYM_DIFF_MAX_BYTES;
  // a byte cut can split a multi-byte character; drop the replacement char it leaves
  const diff = bytes.length > GYM_DIFF_MAX_BYTES ? bytes.subarray(0, GYM_DIFF_MAX_BYTES).toString('utf8').replace(/\uFFFD+$/, '') : text;
  return { diff, sha256: createHash('sha256').update(diff).digest('hex'), redacted: count, truncated };
}

export type RemoteGymClaim = { runId: string; species: string; task: GymTask; genome?: { id: string; lines: string[] }; prod_gates?: ProdGatesConfig; prompt_override?: string; tg?: { experiment: string; generation: string; arm: string }; pl?: { experiment: string; arm: string } } | { skipped: string };
export interface RemoteGymResult { status: 'success' | 'failure' | 'discarded'; reason: string; tokens?: number | null; durationMs?: number; changed_files?: unknown; diff?: unknown; killed_mutants?: unknown; prod_gates?: unknown; fire_check?: unknown; graded?: unknown; graded_kind?: unknown; tg_metrics?: unknown }

/**
 * Tokens the worker reported: a positive count, or null = unknown. gym-worker.mjs before this change sent 0 for every attempt
 * outside TG-001 (it never read the usage), and atomic prints no count when it has none, so a 0 or a missing value is unknown.
 */
export function reportedTokens(value: unknown): number | null {
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** The two settlements the server makes itself (no report from the worker). A report arriving after either is a late result. */
export const LOST_AT_CLAIM = 'infra: worker lost the result (no report before its next claim)';
export const ORPHANED_NO_RESULT = 'infra: orphaned_no_result';
const SERVER_SETTLED = new Set([LOST_AT_CLAIM, ORPHANED_NO_RESULT]);

/** A report for a run that is no longer running (HTTP 409); `existing` is the result the run was settled with. */
export class GymRunSettledError extends Error {
  constructor(readonly existing: { status: string; reason: string } | null) { super('GYM_RUN_ALREADY_SETTLED'); }
}

/**
 * The infra discard for a remote gym run that will never report (claim time: its host claimed again; sweep: no report in time).
 * The task stays untried (an 'infra:' reason), no skill outcome is written, and a TG-001 attempt is settled the same way.
 * A run that already carries a result is never touched. Returns the ids it settled.
 */
function settleLostRuns(db: Database, runs: Array<{ id: string; tg: string | null; pl?: string | null }>, reason: string, now: string): string[] {
  const settle = db.prepare(`UPDATE loop_runs SET status = 'completed', updated_at = ?,
      metadata = json_set(metadata, '$.gym_result', json_object('status', 'discarded', 'reason', ?))
      WHERE id = ? AND status = 'running' AND json_extract(metadata, '$.gym_result') IS NULL`);
  const settled: string[] = [];
  for (const r of runs) {
    if (!settle.run(now, reason, r.id).changes) continue;
    settled.push(r.id);
    if (r.tg) { try { recordTg001(db, r.tg, r.id, { status: 'discarded', reason }, now); } catch { /* bookkeeping */ } }
    // PL-001: a lost report is an infra discard of the arm (re-served, or INFRA_CENSORED after the permitted retries)
    if (r.pl) { try { recordPl001(db, r.pl, plResult({ runId: r.id, status: 'discarded', reason, void: null, prodGates: undefined, tokens: null, now })); } catch { /* bookkeeping */ } }
  }
  return settled;
}

/**
 * GYM_ORPHAN_SWEEP=off (default) | shadow | on. A remote gym run is otherwise settled only by its own host's next claim, so a
 * host that never claims again leaves it 'running' for good (and its task taken). The sweep settles every remote gym run still
 * running without a result GYM_MAKER_TIMEOUT_MS (the worker's maker budget, default 15 min) + 90 min after its claim — the
 * margin covers npm ci, both oracle runs, mutant kills and the production gates — as ORPHANED_NO_RESULT, through the same
 * infra-discard path as the claim. shadow only lists them. At most 50 per tick; called from the hourly dream-evolution tick.
 */
export const GYM_ORPHAN_MARGIN_MS = 90 * 60_000;
export type GymOrphanSweepMode = 'off' | 'shadow' | 'on';
export const gymOrphanSweepMode = (env: NodeJS.ProcessEnv = process.env): GymOrphanSweepMode => (env.GYM_ORPHAN_SWEEP === 'on' || env.GYM_ORPHAN_SWEEP === 'shadow' ? env.GYM_ORPHAN_SWEEP : 'off');
export function gymOrphanAfterMs(env: NodeJS.ProcessEnv = process.env): number {
  const maker = Number(env.GYM_MAKER_TIMEOUT_MS);
  return (Number.isFinite(maker) && maker > 0 ? maker : 900_000) + GYM_ORPHAN_MARGIN_MS;
}
export function sweepOrphanedGymRuns(db: Database, now = new Date(), env: NodeJS.ProcessEnv = process.env): { mode: GymOrphanSweepMode; candidates: string[]; settled: string[] } {
  const mode = gymOrphanSweepMode(env);
  if (mode === 'off') return { mode, candidates: [], settled: [] };
  const before = new Date(now.getTime() - gymOrphanAfterMs(env)).toISOString();
  const runs = db.prepare(`SELECT id, json_extract(metadata, '$.gym.tg.attempt_id') AS tg, json_extract(metadata, '$.gym.pl.attempt_id') AS pl FROM loop_runs
    WHERE loop_name IN ('evolution-gym', '${TG_LOOP}', '${PL_LOOP}') AND status = 'running' AND json_extract(metadata, '$.gym.remote_host') IS NOT NULL
      AND json_extract(metadata, '$.gym_result') IS NULL AND created_at < ? ORDER BY created_at LIMIT 50`).all(before) as Array<{ id: string; tg: string | null; pl: string | null }>;
  const settled = mode === 'on' ? settleLostRuns(db, runs, ORPHANED_NO_RESULT, now.toISOString()) : [];
  return { mode, candidates: runs.map((r) => r.id), settled };
}

export class RemoteGymService {
  private readonly outcomes: SkillEvolutionEngine;
  constructor(private readonly db: Database, private readonly mine: (repo: string) => GymTask[] = mineGymTasks,
    private readonly mineAt: (repo: string, commit: string) => GymTask | null = minedTaskAt) {
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
    // TG-001 runs too: their attempt is settled as an infra discard (re-queued or INFRA_CENSORED), never left 'claimed'
    const lost = this.db.prepare(`SELECT id, json_extract(metadata, '$.gym.tg.attempt_id') AS tg, json_extract(metadata, '$.gym.pl.attempt_id') AS pl FROM loop_runs
      WHERE loop_name IN ('evolution-gym', '${TG_LOOP}', '${PL_LOOP}') AND status = 'running' AND json_extract(metadata, '$.gym.remote_host') = ?`).all(host) as Array<{ id: string; tg: string | null; pl: string | null }>;
    settleLostRuns(this.db, lost, LOST_AT_CLAIM, now.toISOString());
    const since = new Date(now.getTime() - 86_400_000).toISOString();
    if (remoteGymCap(this.db, now.getTime()).capped) return { skipped: 'daily cap reached' };
    // the offered species with the fewest gym outcomes goes next
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM skill_outcomes WHERE domain = 'gym' AND skill_id = ? AND COALESCE(model, '') = ?");
    const healthy = species.filter((s) => !infraFailing(this.db, s.model ? `${s.runtime}@${s.model}` : s.runtime, since));
    if (!healthy.length) return { skipped: 'every species is infra-failing' };
    const pick = healthy.map((s) => ({ s, n: (count.get(`loop-maker:gym:${s.runtime}`, s.model ?? '') as { n: number }).n })).sort((a, b) => a.n - b.n)[0].s;
    let key = pick.model ? `${pick.runtime}@${pick.model}` : pick.runtime;
    const tasks = this.mine(repo);
    // RX-5: the probe takes its share even while trials run (prod 05-10: trials take every claim for days, so a probe
    // behind them never ran); trials and ordinary replays share the rest
    let task: GymTask | undefined; let trialGenome: Genome | null = null; let probe = false; let canary = false;
    // TG-001: the transfer-gap experiment takes the next claim while it runs (prompt per arm sent verbatim; needs a worker that
    // can take a prompt override, write_test tasks and production gates — the primary metric is prod-gated success)
    const caps = (opts.capabilities ?? []).map(String);
    const runId = randomUUID();
    let tg: { experiment: string; generation: string; arm: string; attempt_id: string } | null = null; let promptOverride: string | undefined;
    if (tg001On() && gymProdGatesEnabled() && [TG_CAPABILITY, FAILURE_TASK_CAPABILITY, PROD_GATES_CAPABILITY].every((c) => caps.includes(c))) {
      // B27: the claim that freezes the plan starts no TG attempt, so the plan strictly predates the first physical attempt
      const frozen = tgManifest(this.db);
      if (!frozen) freezeTg001(this.db, this.failureTasks(repo), { checkoutPath: repo, species: key, commit: gitHead(repo), harness: harnessHash(repo),
        prodGates: prodGatesConfig(), reserved: new Set(holdoutKeys(this.db)), now: now.toISOString() });
      const next = frozen && frozen.species === key && frozen.frozen_at < now.toISOString() ? claimTg001(this.db, frozen, runId, now.toISOString()) : null;
      if (next) { task = next.task; promptOverride = next.prompt; tg = { experiment: frozen!.id, generation: TG_GENERATION, arm: next.arm, attempt_id: next.attempt_id }; }
    }
    // PL-001 (PL_001_MODE=on): paired procedure attempts, only for a worker announcing prod_gates + procedure_lines (it reports
    // the received lines digest in its fire check). The claim that freezes the manifest starts no PL attempt. A cap share
    // (PL_001_CAP_SHARE) runs ahead of trials up to its share of the daily cap; otherwise PL waits until the start genomes
    // settled and still yields to trial attempts (served after them, below).
    let pl: { attempt_id: string; arm: 'A' | 'B'; task: GymTask; lines: string[] } | null = null; let plFrozen: PlManifest | null = null;
    const healthyKeys = healthy.map((s) => (s.model ? `${s.runtime}@${s.model}` : s.runtime));
    if (!task && pl001On() && gymProdGatesEnabled() && PL_REQUIRED_CAPABILITIES.every((c) => caps.includes(c))) {
      plFrozen = plManifest(this.db);
      if (!plFrozen) this.freezePl(repo, now);
      else if (plFrozen.frozen_at < now.toISOString() && healthyKeys.includes(plFrozen.species)) {
        try { applyPl001Lifecycle(this.db, plFrozen, plState(this.db, plFrozen, now.getTime()), now.toISOString()); } catch { /* a verdict (day 14) is recorded at the next claim or result */ }
        const start = plStartCondition(this.db);
        if (start.cap_share > 0 && plClaims24h(this.db, now.getTime()) < Math.ceil(start.cap_share * remoteGymCap(this.db, now.getTime()).max)) pl = claimPl001(this.db, plFrozen, runId, now.toISOString());
      } else plFrozen = null;
      if (pl) { task = pl.task; key = plFrozen!.species; }
    }
    if (!task && canaryDue(this.db, (opts.capabilities ?? []).map(String))) {
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
      // WT-HOLDOUT: frozen write_test tasks come after the existing phases, and only a write_test worker can run one
      const writeTests = writeTestHoldoutEnabled() ? writeTestHoldout(this.db, () => this.failureTasks(repo), now.toISOString()) : [];
      const servable = (opts.capabilities ?? []).map(String).includes(FAILURE_TASK_CAPABILITY) ? writeTests : [];
      settleNoHeadroom(this.db, key, frozen, mutants.map((m) => m.commit), now.getTime(), writeTests.map((t) => t.commit)); // B8: no mutant attempt on a trial nothing could win
      // prod 25-10: a frozen mined commit that aged out of the miner's window is rebuilt from its own commit; an item still
      // without a task is skipped for this claim (never returned: that starved the trial) and reported (trialBlocked)
      const frozenMined = new Set(frozen); const resolved = new Map<string, GymTask | undefined>(); const blocked: Array<{ genomeId: string; commit: string }> = [];
      const materialise = (c: string): GymTask | undefined => {
        if (!resolved.has(c)) resolved.set(c, tasks.find((t) => t.commit === c) ?? mutants.find((m) => m.commit === c) ?? servable.find((t) => t.commit === c) ?? (frozenMined.has(c) ? this.mineAt(repo, c) ?? undefined : undefined));
        return resolved.get(c);
      };
      const next = nextTrialAttempt(this.db, key, [...frozen, ...mutants.map((m) => m.commit), ...servable.map((t) => t.commit)],
        (c, genomeId) => { if (materialise(c)) return true; blocked.push({ genomeId, commit: c }); return false; });
      this.trialBlocked(blocked, [...resolved].filter(([, t]) => t).map(([c]) => c), now.toISOString());
      if (next) { task = materialise(next.commit); trialGenome = task ? genome(this.db, next.genomeId) : null; }
      if (!trialGenome) task = undefined;
    }
    if (!task && plFrozen && plStartCondition(this.db).settled) {
      pl = claimPl001(this.db, plFrozen, runId, now.toISOString());
      if (pl) { task = pl.task; key = plFrozen.species; }
    }
    // Batch-8: a failure-derived 'write_test' task (real production failure) — only for a worker that can run one
    if (!task && gymFailureTasksEnabled() && (opts.capabilities ?? []).map(String).includes(FAILURE_TASK_CAPABILITY)) {
      const tried = triedTasks(this.db, key); const held = new Set(holdoutKeys(this.db)); // WT-HOLDOUT: a frozen task is never served outside trials
      task = this.failureTasks(repo).find((t) => !tried.has(t.commit) && !held.has(t.commit));
    }
    if (!task) {
      const tried = triedTasks(this.db, key);
      for (const k of plTaskKeys(this.db)) tried.add(k); // PL-001: a frozen task is the experiment's, never an ordinary replay
      // Y4: the mined fix commits run out (prod 2026-10-01) — then a seeded mutant-repair task keeps the gym supplied
      task = tasks.find((t) => !tried.has(t.commit)) ?? mutantTask(this.db, repo, key, tried) ?? undefined;
    }
    if (!task) return { skipped: 'no untried task' };
    const { mutant: _mutantContent, ...stored } = task as MutantTask; // the mutant goes to the worker, not into every row
    const { canary: _canaryTest, mutants, ...meta } = stored as typeof stored & { canary?: unknown; mutants?: TargetMutant[] };
    const gates = gymProdGatesEnabled() && (opts.capabilities ?? []).map(String).includes(PROD_GATES_CAPABILITY) ? prodGatesConfig() : null;
    const gymMeta = { ...meta, ...(mutants ? { mutant_keys: mutants.map((m) => m.key) } : {}), species: key, remote_host: host, ...(trialGenome ? { genome: trialGenome.id } : {}), ...(probe ? { probe: 1 } : {}), ...(canary ? { canary: 1 } : {}), ...(gates ? { prod_gates: 1 } : {}), ...(tg ? { tg } : {}), ...(pl ? { pl: plClaimMeta(pl) } : {}) };
    // B27 isolation by provenance: a TG-001 run is not an 'evolution-gym' run, so no gym statistic, breaker, IRT, hack rate,
    // graded pool, trial deciding set or estimator (all of which select loop_name = 'evolution-gym') can count it
    this.db.prepare('INSERT INTO loop_runs (id, loop_name, mode, status, repository_path, metadata, created_at, updated_at) VALUES (?, ?, \'closed\', \'running\', ?, ?, ?, ?)')
      .run(runId, tg ? TG_LOOP : pl ? PL_LOOP : 'evolution-gym', repo, JSON.stringify({ gym: gymMeta }), now.toISOString(), now.toISOString());
    if (!tg && !pl) recordEffortGym(this.db, runId, key, task.commit); // EVC effort controller: shadow only (serve vs skip), changes nothing
    // PL-001 (PROCEDURE_SELECTOR_MODE=shadow): an ordinary claim — not TG-001, a trial (either arm), a canary or a holdout task —
    // records whether the procedure applies to its task; nothing is sent, so the payload below is the same as with the mode off
    if (procedureSelectorMode() === 'shadow' && !tg && !pl && !trialGenome && !canary && !holdoutKeys(this.db).includes(task.commit)) {
      recordProcedureSelection(this.db, runId, task, caps, key, now.toISOString());
    }
    return { runId, species: key, task, ...(trialGenome ? { genome: { id: trialGenome.id, lines: trialGenome.lines } } : {}), ...(gates ? { prod_gates: gates } : {}),
      ...(tg ? { prompt_override: promptOverride, tg: { experiment: tg.experiment, generation: tg.generation, arm: tg.arm } } : {}),
      // PL-001 arm B: the procedure's lines, delivered as genome strategy lines are (the worker's gymGoal 'Strategy:'); arm A: none
      ...(pl ? { ...(pl.lines.length ? { genome: { id: PROCEDURE_ID, lines: pl.lines } } : {}), pl: { experiment: PL_ID, arm: pl.arm } } : {}) };
  }

  /** PL-001 freeze on the deploy checkout; a refused freeze is recorded and retried at most hourly (it mutates every candidate file). */
  private freezePl(repo: string, now: Date): void {
    const last = lastPlFreezeRefusal(this.db);
    if (last && Date.parse(last.at) > now.getTime() - 3_600_000) return;
    try {
      const r = freezePl001(this.db, this.plCandidates(repo, PL_SPECIES), { species: PL_SPECIES, commit: gitHead(repo), harness: harnessHash(repo), prodGates: prodGatesConfig(), now: now.toISOString() });
      if (!r.frozen && r.reason) recordPlFreezeRefusal(this.db, r.reason, now.toISOString());
    } catch (e) { recordPlFreezeRefusal(this.db, `freeze failed: ${e instanceof Error ? e.message : String(e)}`, now.toISOString()); }
  }

  /** Injectable for tests: the PL-001 candidate pool — mined repairs plus seeded mutant repairs at tiers 3–6 from the deploy checkout. */
  plCandidates(repo: string, speciesKey: string): GymTask[] {
    const tried = new Set<string | null>([...triedTasks(this.db, speciesKey), ...holdoutKeys(this.db)]);
    const out: GymTask[] = [...this.mine(repo)];
    for (const tier of PL_MUTANT_TIERS) {
      for (let i = 0; i < 60; i++) { const m = mutantTask(this.db, repo, speciesKey, tried, tier); if (!m) break; tried.add(m.commit); out.push(m); }
    }
    return out;
  }

  /**
   * A pending trial item no claim can be given a task for (a frozen mined commit neither in the miner list nor rebuildable from
   * this checkout's history) keeps the trial from completing: one row per (genome, task) in gym_trial_blocked, refreshed while
   * it lasts and cleared once the task can be served again; the stall watch raises 'gym:trial_blocked'. Bookkeeping only.
   */
  private trialBlocked(blocked: Array<{ genomeId: string; commit: string }>, served: string[], now: string): void {
    try {
      const clear = this.db.prepare('DELETE FROM gym_trial_blocked WHERE task_key = ?');
      for (const c of served) clear.run(c);
      const upsert = this.db.prepare(`INSERT INTO gym_trial_blocked (genome_id, task_key, reason, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(genome_id, task_key) DO UPDATE SET reason = excluded.reason, last_seen = excluded.last_seen`);
      for (const b of blocked) upsert.run(b.genomeId, b.commit, 'frozen mined commit is not in the miner task list and cannot be rebuilt from the deploy checkout history', now, now);
    } catch { /* never break a claim */ }
  }

  /** Injectable for tests; production reads the deploy checkout's git history. */
  failureTasks(repo: string) { return failureDerivedTasks(this.db, gitLookup(repo)); }

  record(runId: string, host: string, result: RemoteGymResult): void {
    const row = this.db.prepare("SELECT status, json_extract(metadata, '$.gym') AS gym FROM loop_runs WHERE id = ?").get(runId) as { status: string; gym: string | null } | undefined;
    const gym = row?.gym ? JSON.parse(row.gym) as GymTask & { species: string; remote_host?: string; genome?: string; probe?: number; canary?: number; mutant_keys?: string[]; prod_gates?: number; tg?: { attempt_id: string; experiment?: string }; pl?: PlClaimMeta } : null;
    if (!row || !gym || gym.remote_host !== host) throw new Error('GYM_RUN_NOT_FOUND');
    if (row.status !== 'running') throw this.settled(runId);
    // TG-001 generations: a result for a run claimed under another generation (e.g. before a restore) is never accepted
    if (gym.tg && gym.tg.experiment !== TG_ID) throw new Error('GYM_RUN_STALE_GENERATION');
    if (!['success', 'failure', 'discarded'].includes(result.status)) throw new Error('GYM_RESULT_INVALID');
    // P0-12: the worker's verdict is not taken unchecked. For an ordinary gym run (not a canary — its solved status is the
    // compromise alarm — and not a TG-001 attempt, frozen protocol) a success needs the evidence the worker sends with every
    // scored attempt (changed files + a diff, hashed here); without it the result is an infra discard, never a success.
    // A success the hack classifier flags is 'quarantined': not a win for fitness, gym statistics or genome trials.
    const canonical = !gym.canary && !gym.tg;
    const changedFiles = Array.isArray(result.changed_files) ? result.changed_files.map(String).slice(0, 50) : null;
    const diffText = typeof result.diff === 'string' ? result.diff : '';
    let status: RemoteGymResult['status'] | 'quarantined' = result.status;
    let reason = String(result.reason || '').slice(0, 200);
    if (canonical && status === 'success' && (!changedFiles?.length || !diffText.trim())) {
      status = 'discarded'; reason = 'infra: success without changed_files/diff evidence';
    }
    let hack_flags: string[] | undefined;
    if (status !== 'discarded' && (canonical || hackDetectorShadow())) {
      hack_flags = classifyHack({ changedFiles: changedFiles ?? changedFromReason(reason), diffText: diffText.slice(0, 50_000), reason });
      // a 'write_test' task asks the maker to write the test file: touching it is the task, not a hack
      if ((gym as { kind?: string }).kind === 'write_test') hack_flags = hack_flags.filter((f) => f !== 'tests_touched');
      if (hack_flags.length) {
        try { new LoopEventService(this.db).recordEvent(runId, 'gym_hack_shadow', 'warning', `Gym hack flags (shadow): ${hack_flags.join(', ')}`, { species: gym.species, flags: hack_flags, status: result.status }); } catch { /* never break the report */ }
      }
      if (canonical && status === 'success' && hack_flags.length) status = 'quarantined';
    }
    // GENOME_FIRE_CHECK: a trial attempt without proof that the genome's lines reached the maker is VOID (genome-registry)
    const fire_check = genomeFireCheck() ? parseFireCheck(result.fire_check) : null;
    const voided = genomeFireCheck() ? fireCheckVoid(this.db, gym.genome, status === 'quarantined' ? 'success' : status, fire_check) : null;
    // B8: which of the served mutants the write_test maker's test killed (only keys the server handed out)
    const killed_mutants = Array.isArray(gym.mutant_keys) && Array.isArray(result.killed_mutants) ? result.killed_mutants.map(String).filter((k) => gym.mutant_keys!.includes(k)) : undefined;
    // PL-001: graded is a registered secondary measure, so a PL attempt is graded whatever GRADED_FITNESS_MODE says
    const graded = (status === 'success' || status === 'failure') && (gradedFitnessMode() === 'shadow' || gym.pl) ? gymGraded(gym, { ...result, status }, killed_mutants) : null;
    const tokens = reportedTokens(result.tokens);
    // gym gold agreement: the per-check production gate results of a proxy success (only on a run claimed with the gates)
    const prod_gates = gym.prod_gates ? sanitizeProdGates(result.prod_gates) : undefined;
    // PL-001: the fire check is mandatory in both arms and the oracle must have run the gates; otherwise the attempt is VOID
    const plVoided = gym.pl ? plVoid(gym.pl, gym.prod_gates === 1, status, prod_gates, result.fire_check) : null;
    const plRec = gym.pl ? plResult({ runId, status, reason, void: plVoided, prodGates: prod_gates, hackFlags: hack_flags, graded: graded?.graded ?? null, gradedKind: graded?.graded_kind ?? null,
      tokens, durationMs: result.durationMs, tgMetrics: result.tg_metrics, fireCheck: result.fire_check, now: new Date().toISOString() }) : null;
    // one transaction: the outcome, the stored diff, the run settlement and the TG-001 attempt land together or not at all
    // (a kill between the outcome and the settlement left an outcome on a run the next claim then discarded: counted twice)
    const write = this.db.transaction(() => {
      // TG-001 attempts are an experiment on the prompt, not gym fitness: no skill outcome (the attempt row keeps the result)
      if (status !== 'discarded' && !gym.canary && !voided && !gym.tg && !gym.pl) {
        const [species] = parseSpecies(gym.species, 1);
        this.outcomes.recordOutcome(`loop-maker:gym:${species.runtime}`, {
          success: status === 'success', tokensUsed: tokens, durationMs: Math.max(0, Number(result.durationMs) || 0), domain: 'gym', taskId: runId,
          skillContentHash: gymSkillContentHash((gym as { kind?: string }).kind, gym.genome),
          ...(species.model ? { model: species.model } : {}), evidenceRefs: [`gym:${gym.commit}`, `loop_run:${runId}`, `gym_result:${reason}`, `remote:${host}`, ...(gym.genome ? [`genome:${gym.genome}`] : []), ...(gym.probe ? ['gym:probe'] : []), ...((gym as { kind?: string }).kind === 'write_test' ? ['gym:fail'] : []), ...(status === 'quarantined' ? ['gym:quarantined'] : []), ...(graded ? gradedRefs(graded.graded, graded.graded_kind) : [])],
        });
      }
      const now = new Date().toISOString();
      let diff_ref: string | undefined;
      // a TG-001 diff stays out of the gym training dataset (a copy would lose the experiment's provenance); its sha256 is kept on the run
      if ((gym.tg || gym.pl) && typeof result.diff === 'string' && result.diff.trim()) diff_ref = `sha256:${prepareGymDiff(result.diff).sha256}`;
      else if (gymStoreDiffs() && status !== 'discarded' && typeof result.diff === 'string' && result.diff.trim()) {
        try {
          const d = prepareGymDiff(result.diff);
          this.db.prepare('INSERT OR REPLACE INTO gym_attempt_diffs (run_id, task_key, status, species, sha256, diff, redacted, truncated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(runId, String(gym.commit), status, gym.species, d.sha256, d.diff, d.redacted, d.truncated ? 1 : 0, now);
          diff_ref = `sha256:${d.sha256}`;
        } catch { /* training data only: never break the report */ }
      }
      // P0-12: every recorded success / quarantine carries the server-side hash of the diff it rests on
      if (!diff_ref && canonical && (status === 'success' || status === 'quarantined')) diff_ref = `sha256:${prepareGymDiff(diffText).sha256}`;
      const settled = this.db.prepare("UPDATE loop_runs SET status = 'completed', updated_at = ?, metadata = json_set(metadata, '$.gym_result', json(?)) WHERE id = ? AND status = 'running'")
        .run(now, JSON.stringify({ status, reason, tokens, ...(hack_flags ? { hack_flags } : {}), ...(killed_mutants ? { killed_mutants } : {}),
          ...(prod_gates ? { prod_gates } : {}), ...(graded ?? {}), ...(diff_ref ? { diff_ref } : {}),
          ...(plRec?.fire_check ? { fire_check: plRec.fire_check } : fire_check ? { fire_check } : {}), ...(voided ? { void: voided } : plVoided ? { void: plVoided } : {}) }), runId).changes;
      if (!settled) throw new GymRunSettledError(null); // settled since the read above: the outcome is rolled back
      if (gym.tg?.attempt_id) { try { recordTg001(this.db, gym.tg.attempt_id, runId, { status: result.status, reason, durationMs: result.durationMs, tg_metrics: result.tg_metrics }, now); } catch { /* experiment bookkeeping never breaks the report */ } }
      if (gym.pl?.attempt_id && plRec) { try { recordPl001(this.db, gym.pl.attempt_id, { ...plRec, at: now }); } catch { /* experiment bookkeeping never breaks the report */ } }
    });
    try { write(); } catch (error) { throw error instanceof GymRunSettledError ? this.settled(runId) : error; }
    // PL-001: a completed pair may reach the verdict (60 pairs or harm); its lifecycle decision is recorded on the procedure row
    if (gym.pl) { try { const m = plManifest(this.db); if (m) applyPl001Lifecycle(this.db, m, plState(this.db, m), new Date().toISOString()); } catch { /* bookkeeping */ } }
  }

  /**
   * Idempotent report: a run that is no longer running gets no second outcome; the 409 carries the result it was settled with.
   * When the server settled it itself (lost at the next claim, or orphaned), the arrival is recorded once as gym_result.late_result.
   */
  private settled(runId: string): GymRunSettledError {
    let existing: { status: string; reason: string } | null = null;
    try { existing = JSON.parse((this.db.prepare("SELECT json_extract(metadata, '$.gym_result') AS r FROM loop_runs WHERE id = ?").get(runId) as { r: string | null } | undefined)?.r ?? 'null'); } catch { /* unreadable: no existing result to show */ }
    if (existing && SERVER_SETTLED.has(existing.reason)) {
      try { this.db.prepare("UPDATE loop_runs SET metadata = json_set(metadata, '$.gym_result.late_result', 1) WHERE id = ? AND json_extract(metadata, '$.gym_result.late_result') IS NULL").run(runId); } catch { /* bookkeeping */ }
    }
    return new GymRunSettledError(existing ? { status: existing.status, reason: existing.reason } : null);
  }
}
