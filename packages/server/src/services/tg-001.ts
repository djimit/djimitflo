import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { wilson } from './evolution-estimators';
import { renderWorkAssignment, type AssignmentOmit } from './loop-service';
import { assignmentContext } from './assignment-context';
import { ExperienceRetrievalService } from './experience-retrieval-service';
import { WRITE_TEST_ORACLE, type FailureTask } from './gym-failure-tasks';
import type { LoopFinding } from './loop-discovery-service';

/**
 * TG-001 (operator 11-10, protocol docs/research/ace/TG-001_PROTOCOL.md): why does the workstation maker succeed 78.8 % in
 * the gym and 7.0 % in production? First hypothesis: the assignment REPRESENTATION. The same frozen write_test task (same
 * base commit, target, oracle, seeded mutants, production gates) runs under four prompts:
 *   A MINIMAL_GYM          today's one-line gym goal (scripts/gym-worker.mjs gymGoal)
 *   B FULL_PRODUCTION      the real production LOOP_WORK.md of the failed run the task came from (renderWorkAssignment),
 *                          flattened to one line exactly like a production remote maker job (#609 oneLine)
 *   C CONTROLLED_PRODUCTION B without the parts that should not matter for solving (TG_C_REMOVED)
 *   D STRUCTURED_MINIMAL   A plus only the production finding message and suggested fix
 * Every prompt is rendered once at freeze time and stored in the manifest, so later code or memory changes cannot alter it.
 * Order: Latin square over a seeded task order, so every arm runs in every position equally often. TG attempts are served
 * before ordinary gym work (inside the remote gym's daily cap) and earn no gym skill outcome (they are not gym fitness).
 *   TG_001_MODE=on (default off)
 */
export const tg001On = (env: NodeJS.ProcessEnv = process.env): boolean => env.TG_001_MODE === 'on';
/** The pre-registered experiment (plan + analysis.experiment_id); kept out of every generation so the plan's fingerprints carry no generation. */
export const TG_PLAN_ID = 'tg-001';
/**
 * Each physical execution of the frozen plan is a generation (docs/research/ace/TG-001_R1_INCIDENT.md). r1 was lost to a
 * provider snapshot rollback; r2 is current. Every row and key that identifies an attempt, claim or result carries TG_ID;
 * rows of another generation are never served, resumed, settled or pooled.
 */
export const TG_GENERATION = 'r2';
export const TG_ID = `${TG_PLAN_ID}-${TG_GENERATION}`;
/**
 * Prior generations — a durable record, not data: never inserted into tg_experiments/tg_attempts, never counted in any
 * analysis. r1 values are the GO checklist recorded externally at 2026-10-11T23:20:22Z.
 */
export const TG_PRIOR_GENERATIONS = [{
  generation: 'r1', experiment_id: TG_PLAN_ID, status: 'ABORTED_DATA_LOSS', frozen_at: '2026-10-11T23:04:15Z', first_attempt_at: '2026-10-11T23:25:18Z',
  attempts_executed: '~5 UNKNOWN/LOST', cause: 'provider snapshot rollback to ~2026-10-11T04:11Z', pooled: false,
  record_at: '2026-10-11T23:20:22Z',
  analysis_fingerprint: 'ff29c34441f68804b0177b0599f673f369386e139234662eeb33f23d234e70ec',
  task_set_fingerprint: 'd0eee603a3afa4fbf1988f9bd9a26c4bc0564ae1d98e08d02755a578a57e1594',
  prompt_fingerprints: { A: '1ca310dc176dcf2a0658857dd03f157f7cd7fd7d9a6b9f4bbae9a1dd7bf33ca0', B: 'fa7fdcc1238f085e84e161f5c04f92db630115e22e123aca1f64bafc711df5f5',
    C: '5a8270f5f6833182166ed7ef5dc1c0d77057b297e3672c0667e09fa968dfa4c4', D: '8736acc0038db7db96a13bfb2d0e7cf9856bdfc1076cb84eb275c10313ddb671' },
  seed: 11102026, gate_version: '633dd7a096aba028eebff3228fd4a0cd23ec044cf089cd6caad95c4890a6ba47', classifier_version: 'tg-classifier-v2', step_budget: 40,
  model_router: 'atomic@llama-router', worker_version: 'scripts/gym-worker.mjs@sha256:409ef06ef0de45c091cd2705538b04ef1dafcc6940f9b9707f45d0bdb3f8a7d1',
  git_commit: 'a4f241c1a381bb4217f98450bdc83705520fbf19',
}] as const;
export type TgPlanRecord = { analysis_fingerprint: string; task_set_fingerprint: string; prompt_fingerprints: Record<TgArm, string>; seed: number; gate_version: string;
  classifier_version: string; step_budget: number; model_router: string; frozen_at: string; git_commit: string | null; worker_version: string | null };
export const TG_R1: TgPlanRecord = TG_PRIOR_GENERATIONS[0];
/** B27: loop_runs.loop_name of TG-001 attempts — never 'evolution-gym', so gym statistics exclude them by provenance */
export const TG_LOOP = 'tg-001';
export const TG_ARMS = ['A', 'B', 'C', 'D'] as const;
export type TgArm = typeof TG_ARMS[number];
export const TG_TASKS = 20;
export const TG_MIN_TASKS = 10;
export const TG_SEED = 11_10_2026;
export const TG_CAPABILITY = 'prompt_override';
/** What arm C leaves out of B (renderWorkAssignment omit keys) — each one named in the protocol. */
export const TG_C_REMOVED: AssignmentOmit[] = ['ids', 'advisory', 'policy'];
/** An infrastructure discard puts the attempt back in the queue, at most this many times. */
export const TG_MAX_INFRA_RETRIES = 2;
/** Recorded in the go-checklist (B27); a change to classifyTgFailure must bump it and start a new experiment version. */
export const TG_CLASSIFIER_VERSION = 'tg-classifier-v2'; // v2 = #777 word-boundary fix
/** The gym worker's atomic --max-steps for every arm (production remote makers run 60: the next experiment). */
export const TG_STEP_BUDGET = 40;
/** Integrity addendum (pre-data, 11-10): minimum practically relevant paired difference A − B, and the test level. */
export const TG_MDE = 0.2;
export const TG_ALPHA = 0.05;
export const TG_LABEL = 'diagnostic: prompt sensitivity under the gym harness (max-steps 40) — not a generalization benchmark, not a promotion holdout';
/** Canonical JSON (sorted object keys) for the analysis-manifest fingerprint. */
export const canonicalJson = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x));

/** Arm A — must equal scripts/gym-worker.mjs gymGoal(task, true, []) (tg-001.test.ts compares them). */
export function armAGoal(task: { source: string; target: string }): string {
  const cmd = `cd packages/server && npx vitest run ${task.source.replace(/^packages\/server\//, '')}`;
  return `Evolution gym: write the vitest test file ${task.source} that covers ${task.target}. Import ${task.target} with a relative import, do not mock it, assert its real behaviour with expect precisely enough that a subtly broken ${task.target} makes the test fail, skip nothing, and make it pass with: ${cmd}. Change only ${task.source}; do not edit ${task.target} or any other file.`;
}
export const oneLine = (text: string): string => String(text).replace(/\s*\n+\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

/** Small deterministic PRNG (mulberry32) for the frozen order. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffle<T>(items: T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

/** Latin square: seeded task order; task i runs the seeded base arm order rotated by i, so each arm takes each position equally often. */
export function tgSchedule(taskKeys: string[], seed = TG_SEED): Array<{ seq: number; task_key: string; arm: TgArm }> {
  const rand = prng(seed);
  const order = shuffle(taskKeys, rand); const base = shuffle([...TG_ARMS], rand);
  const out: Array<{ seq: number; task_key: string; arm: TgArm }> = [];
  order.forEach((key, i) => { for (let k = 0; k < base.length; k++) out.push({ seq: out.length, task_key: key, arm: base[(k + i) % base.length] }); });
  return out;
}

/** The production assignment pieces of the failed run a write_test task came from; null when the run or its finding is gone. */
export function productionArms(db: Database, task: FailureTask, checkoutPath: string, env: NodeJS.ProcessEnv = process.env): Record<TgArm, string> | null {
  const run = db.prepare('SELECT id, loop_name, goal_id, findings_json FROM loop_runs WHERE id = ?').get(task.run_id) as { id: string; loop_name: string; goal_id: string | null; findings_json: string | null } | undefined;
  if (!run) return null;
  let findings: LoopFinding[] = [];
  try { findings = JSON.parse(run.findings_json || '[]') as LoopFinding[]; } catch { return null; }
  const leaseFinding = (db.prepare("SELECT finding_id FROM worker_leases WHERE loop_run_id = ? AND role = 'maker' ORDER BY created_at LIMIT 1").get(run.id) as { finding_id: string | null } | undefined)?.finding_id;
  const finding = findings.find((f) => f.id === leaseFinding) ?? findings[0];
  if (!finding || typeof finding.message !== 'string') return null;
  const experience = new ExperienceRetrievalService(db);
  const results = experience.retrieveLocalRelevantRuns(`${run.loop_name} ${finding.message} ${finding.suggested_fix}`, 3);
  const advisory = results.length ? experience.formatExperienceContext(results) : '';
  // production control context (no ACE/STE arm): assignmentContext seals rules and logs memory reads; those writes are rolled
  // back so freezing a prompt never changes which rule production picks next
  let extra: ReturnType<typeof assignmentContext> = { examples: [], rules: [] };
  const ROLLBACK = new Error('tg-001: read only');
  try { db.transaction(() => { extra = assignmentContext(db, run, checkoutPath, `tg-001:${run.id}`, { ...env, ACE_001_MODE: 'off', STE_001_MODE: 'off' }); throw ROLLBACK; })(); } catch (e) { if (e !== ROLLBACK) return null; }
  const A = armAGoal(task);
  const B = renderWorkAssignment(run, finding, 'remote', advisory, extra);
  const C = renderWorkAssignment(run, finding, 'remote', advisory, extra, { omit: TG_C_REMOVED });
  const D = [A, `Finding: ${finding.message}`, `Suggested fix: ${finding.suggested_fix}`].join('\n');
  return { A, B, C, D };
}

export interface TgManifest {
  id: string; generation?: string; frozen_at: string; commit: string | null; species: string; harness: string | null; evaluator: { oracle: string; prod_gates: unknown };
  flags: Record<string, string | null>; seed: number; arms: Record<TgArm, string>; c_removed: AssignmentOmit[];
  tasks: Array<{ key: string; lane: string; run_id: string; base: string; source: string; target: string; prior_gym_attempts: number; prompt_sha256: Record<TgArm, string>; prompts: Record<TgArm, string>; task: FailureTask }>;
  skipped: Array<{ key: string; reason: string }>;
  /** integrity addendum: the analysis plan, frozen in the same transaction as the tasks, before any outcome exists */
  analysis?: TgAnalysis;
}
export interface TgAnalysis {
  experiment_id: string; frozen_at: string; commit: string | null; worker_version: string | null; task_ids: string[];
  task_fingerprints: Record<string, string>; prompt_fingerprints: Record<string, Record<TgArm, string>>; seed: number;
  condition_order: Array<{ seq: number; task_key: string; arm: TgArm }>;
  retry_policy: string; exclusion_policy: string[]; scoring_gates: unknown;
  primary: string; secondary: string[]; tests: string[]; ci_method?: string; mde: number; alpha: number; interpretation: string[];
  classifier_version?: string; step_budget?: number;
  prior_exposure: Record<string, { prior_exposure: boolean; prior_attempt_count: number; prior_condition_if_known: TgArm | null }>;
  label: string;
}
export const TG_INTERPRETATION = [
  `A − B ≥ ${TG_MDE} with exact McNemar p < ${TG_ALPHA}: assignment representation is a supported contributor (within the gym harness) → next: prompt-component ablation (C vs B, D vs B) before any gym redesign`,
  `upper 95 % bound of A − B < ${TG_MDE}: representation rejected as the dominant explanation within this environment → next: 40 vs 60 max-steps with task, prompt, model, worker, runtime and evaluator fixed`,
  'otherwise inconclusive → extend to 40 tasks (protocol stopping rule); never change arms, prompts or the primary comparison after outcomes',
];
export const TG_NOT_TESTED = ['step budget (gym max-steps 40 vs production 60)', 'production harness, runtime, tools and checker', 'unseen-task generalization (most tasks have prior arm-A exposure)', 'model routing', 'task distribution'];
export const TG_FLAGS = ['GYM_PROD_GATES', 'GYM_FAILURE_TASKS_ENABLED', 'LOOP_MEMORY_RULES_ENABLED', 'LOOP_SKILL_CARDS_ENABLED', 'MEMORY_HOLDOUT_RATE', 'LOOP_DAEMON_CHECK_SCRIPTS', 'EVOLUTION_GYM_REMOTE_MAX_PER_DAY', 'GYM_MAKER_TIMEOUT_MS'];

export function tgManifest(db: Database): TgManifest | null {
  try { const row = db.prepare('SELECT manifest_json FROM tg_experiments WHERE id = ?').get(TG_ID) as { manifest_json: string } | undefined; return row ? JSON.parse(row.manifest_json) as TgManifest : null; } catch { return null; }
}

/**
 * Freeze once: TG_TASKS write_test tasks stratified by lane (proportional), never a holdout key, tasks no gym species has tried
 * first (their arm-A rate is unknown), then a seeded order. Fewer than TG_MIN_TASKS renderable tasks → nothing is frozen.
 */
export function freezeTg001(db: Database, tasks: FailureTask[], ctx: { checkoutPath: string; species: string; commit: string | null; harness: string | null; prodGates: unknown; reserved: Set<string>; now: string }, env: NodeJS.ProcessEnv = process.env): { frozen: boolean; reason?: string; manifest?: TgManifest } {
  const existing = tgManifest(db);
  if (existing) return { frozen: true, manifest: existing };
  const priorRows = db.prepare("SELECT json_extract(metadata, '$.gym.commit') AS k, COUNT(*) AS n FROM loop_runs WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym.commit') LIKE 'fail:%' GROUP BY 1").all() as Array<{ k: string; n: number }>;
  const prior = new Map(priorRows.map((r) => [r.k, r.n]));
  const rand = prng(TG_SEED);
  const pool = shuffle(tasks.filter((t) => !ctx.reserved.has(t.commit)), rand).sort((a, b) => Number((prior.get(a.commit) ?? 0) > 0) - Number((prior.get(b.commit) ?? 0) > 0));
  const lanes = [...new Set(pool.map((t) => t.lane))];
  const quota = new Map(lanes.map((l) => [l, Math.round((TG_TASKS * pool.filter((t) => t.lane === l).length) / Math.max(1, pool.length))]));
  const picked: TgManifest['tasks'] = []; const skipped: TgManifest['skipped'] = [];
  const take = (t: FailureTask) => {
    const prompts = productionArms(db, t, ctx.checkoutPath, env);
    if (!prompts) { skipped.push({ key: t.commit, reason: 'production run or finding not found' }); return; }
    picked.push({ key: t.commit, lane: t.lane, run_id: t.run_id, base: t.base, source: t.source, target: t.target, prior_gym_attempts: prior.get(t.commit) ?? 0,
      prompts, prompt_sha256: Object.fromEntries(TG_ARMS.map((a) => [a, sha(oneLine(prompts[a]))])) as Record<TgArm, string>, task: t });
  };
  for (const lane of lanes) for (const t of pool.filter((x) => x.lane === lane)) { if (picked.filter((p) => p.lane === lane).length >= (quota.get(lane) ?? 0) || picked.length >= TG_TASKS) break; take(t); }
  for (const t of pool) { if (picked.length >= TG_TASKS) break; if (!picked.some((p) => p.key === t.commit) && !skipped.some((s) => s.key === t.commit)) take(t); }
  if (picked.length < TG_MIN_TASKS) return { frozen: false, reason: `only ${picked.length} renderable write_test tasks (need ${TG_MIN_TASKS})` };
  const manifest: TgManifest = {
    id: TG_ID, generation: TG_GENERATION, frozen_at: ctx.now, commit: ctx.commit, species: ctx.species, harness: ctx.harness, evaluator: { oracle: WRITE_TEST_ORACLE, prod_gates: ctx.prodGates },
    flags: Object.fromEntries(TG_FLAGS.map((f) => [f, env[f] ?? null])), seed: TG_SEED,
    arms: { A: 'MINIMAL_GYM', B: 'FULL_PRODUCTION', C: 'CONTROLLED_PRODUCTION', D: 'STRUCTURED_MINIMAL' }, c_removed: TG_C_REMOVED, tasks: picked, skipped,
  };
  const schedule = tgSchedule(picked.map((p) => p.key));
  manifest.analysis = tgAnalysisPlan(manifest, schedule);
  const ins = db.prepare("INSERT INTO tg_attempts (id, experiment_id, task_key, arm, seq, status, retries, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)");
  db.transaction(() => {
    db.prepare('INSERT INTO tg_experiments (id, frozen_at, manifest_json, analysis_sha256) VALUES (?, ?, ?, ?)').run(TG_ID, ctx.now, JSON.stringify(manifest), sha(canonicalJson(manifest.analysis)));
    for (const s of schedule) ins.run(`${TG_ID}:${randomUUID()}`, TG_ID, s.task_key, s.arm, s.seq, ctx.now);
  })();
  return { frozen: true, manifest };
}

/** Integrity addendum: the analysis plan, fixed before any outcome. Prior gym attempts on a task ran the ordinary gym goal = arm A. */
export function tgAnalysisPlan(m: TgManifest, schedule: Array<{ seq: number; task_key: string; arm: TgArm }>): TgAnalysis {
  return {
    // the plan's id, not the generation's: identical tasks/prompts/seed reproduce the same analysis fingerprint in every generation
    experiment_id: TG_PLAN_ID, frozen_at: m.frozen_at, commit: m.commit, worker_version: m.harness, task_ids: m.tasks.map((t) => t.key),
    task_fingerprints: Object.fromEntries(m.tasks.map((t) => [t.key, sha(canonicalJson(t.task))])),
    prompt_fingerprints: Object.fromEntries(m.tasks.map((t) => [t.key, t.prompt_sha256])), seed: m.seed, condition_order: schedule,
    retry_policy: `an infra discard re-queues the same (task, arm) at most ${TG_MAX_INFRA_RETRIES}×; retries are not observations — the first non-infra result is the observation`,
    exclusion_policy: ['INFRA_CENSORED: every permitted attempt was an infra discard (neither success nor failure; reported per arm, excluded from paired tables)',
      'INVALID: a task discard (the task itself failed, e.g. gap already closed) — excluded and reported', 'historical gym attempts are never observations'],
    scoring_gates: m.evaluator, primary: 'A vs B: paired discordance, exact two-sided McNemar, absolute paired difference A − B with 95 % Tango score CI (unit = (task, arm); task = block); verdict on unrounded values',
    secondary: ["Cochran's Q over the four arms (complete blocks, chi-square df = 3)", 'then only the predeclared contrasts C vs B and D vs B (exact McNemar); no other pairwise tests'],
    tests: ['mcnemar_exact', 'cochran_q_chi2'], ci_method: 'tango score interval (paired difference)', mde: TG_MDE, alpha: TG_ALPHA, interpretation: TG_INTERPRETATION,
    classifier_version: TG_CLASSIFIER_VERSION, step_budget: TG_STEP_BUDGET,
    prior_exposure: Object.fromEntries(m.tasks.map((t) => [t.key, { prior_exposure: t.prior_gym_attempts > 0, prior_attempt_count: t.prior_gym_attempts, prior_condition_if_known: t.prior_gym_attempts > 0 ? 'A' as TgArm : null }])),
    label: TG_LABEL,
  };
}

/**
 * The analysis may only run on the plan frozen before the data: the stored fingerprint must match the manifest's analysis,
 * and the plan must predate every outcome. Anything else (missing plan, edited plan, late plan) → no analysis.
 */
export function tgAnalysisValidity(db: Database, m: TgManifest): { valid: boolean; reason: string | null } {
  if (!m.analysis) return { valid: false, reason: 'no frozen analysis manifest' };
  let row: { frozen_at: string; analysis_sha256: string | null } | undefined;
  try { row = db.prepare('SELECT frozen_at, analysis_sha256 FROM tg_experiments WHERE id = ?').get(m.id) as typeof row; } catch { return { valid: false, reason: 'analysis fingerprint unreadable' }; }
  if (!row?.analysis_sha256) return { valid: false, reason: 'no stored analysis fingerprint' };
  if (sha(canonicalJson(m.analysis)) !== row.analysis_sha256) return { valid: false, reason: 'analysis manifest changed after freeze' };
  if (m.analysis.frozen_at !== row.frozen_at) return { valid: false, reason: 'analysis manifest frozen_at differs from the experiment row' };
  const first = firstPhysicalAttempt(db, m.id);
  if (first === undefined) return { valid: false, reason: 'attempt history unreadable' };
  if (first && m.analysis.frozen_at >= first) return { valid: false, reason: `analysis manifest (${m.analysis.frozen_at}) not written before the first physical attempt (${first})` };
  return { valid: true, reason: null };
}

/**
 * B27 go-checklist: what must be recorded immediately before the worker is enabled, and the checks that gate TG-001 = GO.
 * Read-only. `deploy` comes from the running build (/health), `worker_sha256` from the installed worker file.
 */
export function tgGoChecklist(db: Database, deploy: { commit: string | null; build_id: string | null; worker_sha256: string | null }, env: NodeJS.ProcessEnv = process.env, now = new Date().toISOString()) {
  const m = tgManifest(db);
  const validity = m ? tgAnalysisValidity(db, m) : { valid: false, reason: 'not frozen' };
  const first = m ? firstPhysicalAttempt(db, m.id) : null;
  const record = m ? {
    experiment_id: m.id, generation: m.generation ?? null, git_commit: m.commit, deploy_commit: deploy.commit, build_id: deploy.build_id, worker_version: m.harness, installed_worker_sha256: deploy.worker_sha256,
    analysis_fingerprint: sha(canonicalJson(m.analysis)), task_set_fingerprint: sha(canonicalJson(m.tasks.map((t) => t.key))),
    prompt_fingerprints: Object.fromEntries(TG_ARMS.map((a) => [a, sha(canonicalJson(m.tasks.map((t) => sha(t.prompts[a]))))])),
    seed: m.seed, gate_version: sha(canonicalJson(m.evaluator ?? null)), classifier_version: TG_CLASSIFIER_VERSION, retry_policy: `infra discard re-queued ≤ ${TG_MAX_INFRA_RETRIES}×; semantic failures never retried`,
    step_budget: TG_STEP_BUDGET, model_router: m.species, flags: Object.fromEntries(TG_FLAGS.map((f) => [f, env[f] ?? null])), timestamp: now } : null;
  const checks = {
    frozen: Boolean(m), analysis_valid: validity.valid, analysis_reason: validity.reason,
    plan_predates_first_attempt: first === null ? true : first === undefined ? false : Boolean(m && m.analysis && m.analysis.frozen_at < first),
    no_attempt_yet: first === null,
    worker_matches_manifest: Boolean(m && m.harness && deploy.worker_sha256 && (m.harness === deploy.worker_sha256 || m.harness.endsWith(`:${deploy.worker_sha256}`))),
    deploy_matches_manifest: Boolean(m && deploy.commit && m.commit === deploy.commit),
    plan_matches_r1: false,
  };
  const differs = m && record ? tgPlanDiff(m, record) : ['not frozen'];
  checks.plan_matches_r1 = differs.length === 0;
  const plan_reuse = { compared_to: 'r1', matches: checks.plan_matches_r1, differs,
    // commit and worker may differ between generations; they are recorded here, never compared
    recorded_separately: { git_commit: { r1: TG_R1.git_commit, current: m?.commit ?? null }, worker_version: { r1: TG_R1.worker_version, current: m?.harness ?? null } } };
  return { record, checks, plan_reuse, go: Object.entries(checks).every(([k, v]) => k === 'analysis_reason' || k === 'no_attempt_yet' || v === true) };
}

/**
 * plan_matches_r1: the plan fields of this generation that differ from the frozen r1 plan (empty = the same plan). The analysis
 * object carries frozen_at, commit and worker_version, which a new generation cannot share, so its fingerprint is compared with
 * those three set to r1's. r1's frozen_at is recorded to the second; the unknown milliseconds of the original toISOString()
 * are tried (.000–.999) — a deterministic 1000-candidate check, not a search over plan content.
 */
export function tgPlanDiff(m: TgManifest, rec: { task_set_fingerprint: string; prompt_fingerprints: Record<string, string>; seed: number; gate_version: string;
  classifier_version: string; step_budget: number; model_router: string }, r1: TgPlanRecord = TG_R1): string[] {
  const out: string[] = [];
  if (!m.analysis) out.push('analysis_fingerprint');
  else {
    const bare = /^(.*T\d{2}:\d{2}:\d{2})Z$/.exec(r1.frozen_at);
    const candidates = bare ? [r1.frozen_at, ...Array.from({ length: 1000 }, (_, i) => `${bare[1]}.${String(i).padStart(3, '0')}Z`)] : [r1.frozen_at];
    const as = (frozen_at: string) => sha(canonicalJson({ ...m.analysis, frozen_at, commit: r1.git_commit, worker_version: r1.worker_version }));
    if (!candidates.some((f) => as(f) === r1.analysis_fingerprint)) out.push('analysis_fingerprint');
  }
  if (rec.task_set_fingerprint !== r1.task_set_fingerprint) out.push('task_set_fingerprint');
  for (const a of TG_ARMS) if (rec.prompt_fingerprints[a] !== r1.prompt_fingerprints[a]) out.push(`prompt_fingerprints.${a}`);
  for (const k of ['seed', 'gate_version', 'classifier_version', 'step_budget', 'model_router'] as const) if (rec[k] !== r1[k]) out.push(k);
  return out;
}

/** Earliest physical execution attempt (claim or result) of the experiment; null = none yet; undefined = unreadable. */
export function firstPhysicalAttempt(db: Database, experimentId: string): string | null | undefined {
  let first: string | null = null;
  try {
    for (const r of db.prepare('SELECT first_claimed_at, history_json FROM tg_attempts WHERE experiment_id = ?').all(experimentId) as Array<{ first_claimed_at: string | null; history_json: string | null }>) {
      if (r.first_claimed_at && (!first || r.first_claimed_at < first)) first = r.first_claimed_at;
      for (const h of (r.history_json ? JSON.parse(r.history_json) : []) as Array<{ at?: string }>) if (h.at && (!first || h.at < first)) first = h.at;
    }
  } catch { return undefined; }
  return first;
}

/** The next queued (task, arm), oldest seq first; it is marked claimed for this run. */
export function claimTg001(db: Database, manifest: TgManifest, runId: string, now: string): { attempt_id: string; arm: TgArm; task: FailureTask; prompt: string } | null {
  if (manifest.id !== TG_ID) return null; // a manifest of another generation is never served
  const row = db.prepare("SELECT id, task_key, arm FROM tg_attempts WHERE experiment_id = ? AND status = 'pending' ORDER BY seq LIMIT 1").get(TG_ID) as { id: string; task_key: string; arm: TgArm } | undefined;
  if (!row) return null;
  const entry = manifest.tasks.find((t) => t.key === row.task_key);
  if (!entry) return null;
  // first_claimed_at = the first physical execution attempt (B27): the analysis plan must predate it, not only the first result
  db.prepare("UPDATE tg_attempts SET status = 'claimed', run_id = ?, updated_at = ?, first_claimed_at = COALESCE(first_claimed_at, ?) WHERE id = ?").run(runId, now, now, row.id);
  return { attempt_id: row.id, arm: row.arm, task: entry.task, prompt: entry.prompts[row.arm] };
}

export type TgFailure = 'UNDERSTANDING_FAILURE' | 'PLANNING_FAILURE' | 'CONTEXT_FAILURE' | 'TOOL_FAILURE' | 'IMPLEMENTATION_FAILURE' | 'TEST_FAILURE' | 'TIMEOUT' | 'INFRASTRUCTURE_FAILURE' | 'EVALUATOR_FAILURE' | 'UNKNOWN_FAILURE';
export interface TgMetrics { prompt_sha256?: string | null; prompt_chars?: number | null; tokens?: number | null; tool_calls?: number | null; failed_tool_calls?: number | null;
  files_inspected?: string[] | null; files_modified?: string[] | null; retries?: number | null; termination?: string | null; model?: string | null; oracle_green?: boolean | null; maker_ms?: number | null }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const strs = (v: unknown): string[] | null => (Array.isArray(v) ? v.map(String).slice(0, 50).map((s) => s.slice(0, 200)) : null);
/** Only known fields with sane types are stored; anything missing stays null (never a guessed value). */
export function sanitizeTgMetrics(v: unknown): TgMetrics {
  const m = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  return { prompt_sha256: typeof m.prompt_sha256 === 'string' && /^[0-9a-f]{64}$/.test(m.prompt_sha256) ? m.prompt_sha256 : null, prompt_chars: num(m.prompt_chars), tokens: num(m.tokens),
    tool_calls: num(m.tool_calls), failed_tool_calls: num(m.failed_tool_calls), files_inspected: strs(m.files_inspected), files_modified: strs(m.files_modified), retries: num(m.retries),
    termination: typeof m.termination === 'string' ? m.termination.slice(0, 60) : null, model: typeof m.model === 'string' ? m.model.slice(0, 120) : null,
    oracle_green: typeof m.oracle_green === 'boolean' ? m.oracle_green : null, maker_ms: num(m.maker_ms) };
}

/**
 * Deterministic failure category from what was recorded. UNDERSTANDING only with a defensible signal: the maker exited
 * cleanly within 60 s and changed nothing (the #609 'Ready. What would you like me to do?' pattern); TOOL_FAILURE only with
 * observed failed tool calls (atomic does not report them today, so it never fires); otherwise UNKNOWN_FAILURE.
 */
export function classifyTgFailure(status: string, reason: string, m: TgMetrics): TgFailure | null {
  if (status === 'success') return null;
  if (m.termination === 'timeout') return 'TIMEOUT';
  if (/^infra:/.test(reason)) return 'INFRASTRUCTURE_FAILURE';
  if (/^task:/.test(reason)) return 'EVALUATOR_FAILURE';
  if (/^out of scope/.test(reason)) return 'CONTEXT_FAILURE';
  if (/^prod_gate_failed:/.test(reason)) return 'IMPLEMENTATION_FAILURE';
  if (/^no change/.test(reason)) {
    if ((m.failed_tool_calls ?? 0) > 0) return 'TOOL_FAILURE';
    if (m.termination === 'exit:0' && m.maker_ms !== null && m.maker_ms !== undefined && m.maker_ms < 60_000) return 'UNDERSTANDING_FAILURE';
    return 'UNKNOWN_FAILURE';
  }
  if (/\b(tests still red|no seeded mutant|mutant|does not import|mock|expect|skip)/i.test(reason)) return 'TEST_FAILURE';
  return 'UNKNOWN_FAILURE';
}

/** A run's result settles its attempt; an infra discard (or a timeout without a change) re-queues it up to TG_MAX_INFRA_RETRIES. */
export function recordTg001(db: Database, attemptId: string, runId: string, result: { status: string; reason: string; durationMs?: unknown; tg_metrics?: unknown }, now: string): void {
  // only an attempt of the current generation is ever settled (a pre-restore claim never resumes)
  const row = db.prepare('SELECT status, retries, history_json FROM tg_attempts WHERE id = ? AND run_id = ? AND experiment_id = ?').get(attemptId, runId, TG_ID) as { status: string; retries: number; history_json: string | null } | undefined;
  if (!row || row.status !== 'claimed') return;
  const metrics = sanitizeTgMetrics(result.tg_metrics);
  const failure = classifyTgFailure(result.status, String(result.reason || ''), metrics);
  const rec = { generation: TG_GENERATION, run_id: runId, status: result.status, reason: String(result.reason || '').slice(0, 200), duration_ms: num(result.durationMs), failure, metrics, at: now };
  const history = [...(row.history_json ? JSON.parse(row.history_json) as unknown[] : []), rec];
  const infra = result.status === 'discarded' && /^infra:/.test(rec.reason);
  const status = infra && row.retries < TG_MAX_INFRA_RETRIES ? 'pending' : result.status === 'discarded' ? (infra ? 'infra_exhausted' : 'invalid') : 'done';
  db.prepare('UPDATE tg_attempts SET status = ?, retries = ?, result_json = ?, history_json = ?, run_id = CASE WHEN ? = \'pending\' THEN NULL ELSE run_id END, updated_at = ? WHERE id = ?')
    .run(status, infra ? row.retries + 1 : row.retries, JSON.stringify(rec), JSON.stringify(history), status, now, attemptId);
}

/** Two-sided exact McNemar: binomial(b + c, 1/2) on the discordant pairs. */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c; if (n === 0) return 1;
  let s = 0; let coef = 1; const k = Math.min(b, c);
  for (let i = 0; i <= k; i++) { if (i > 0) coef = (coef * (n - i + 1)) / i; s += coef; }
  return Math.min(1, (2 * s) / 2 ** n);
}

/**
 * Tango (1998) score interval for the paired difference (b − c)/n: the roots of
 * Z(Δ) = (b − c − nΔ) / √(n(2q̃ + Δ(1 − Δ))) = ±z, with q̃ the restricted MLE of the B-only cell under Δ.
 * It depends only on (b, c, n) — like the exact McNemar test — and never collapses to a zero-width interval.
 * Pre-data fix (B27): the Wald interval used before gave [0, 0] at zero discordance and REJECTED e.g. b = 4, c = 0, n = 40
 * (upper bound 0.193) where the score interval reaches 0.22 (docs/research/ace/TG-001_DECISION_SURFACE.md).
 */
export function tangoInterval(b: number, c: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [-1, 1];
  const score = (d: number): number => {
    const A = 2 * n; const B = -b - c + (2 * n - b + c) * d; const C = -c * d * (1 - d);
    const q = (Math.sqrt(Math.max(0, B * B - 4 * A * C)) - B) / (2 * A);
    const v = n * (2 * q + d * (1 - d));
    return v <= 0 ? (b - c - n * d === 0 ? 0 : Math.sign(b - c - n * d) * Infinity) : (b - c - n * d) / Math.sqrt(v);
  };
  const root = (lo: number, hi: number, target: number): number => { // score() decreases in d
    for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (score(mid) > target) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  };
  const d = (b - c) / n;
  return [d <= -1 ? -1 : root(-1, d, z), d >= 1 ? 1 : root(d, 1, -z)];
}

/** Paired comparison x vs y over tasks where both arms produced a scored (success/failure) result. */
export function pairedTable(rows: Array<{ task_key: string; arm: string; status: string }>, x: TgArm, y: TgArm) {
  const by = new Map<string, Record<string, boolean>>();
  for (const r of rows) if (r.status === 'success' || r.status === 'failure') { const m = by.get(r.task_key) ?? {}; m[r.arm] = r.status === 'success'; by.set(r.task_key, m); }
  let both = 0; let xOnly = 0; let yOnly = 0; let neither = 0;
  for (const m of by.values()) { if (!(x in m) || !(y in m)) continue; if (m[x] && m[y]) both++; else if (m[x]) xOnly++; else if (m[y]) yOnly++; else neither++; }
  const n = both + xOnly + yOnly + neither;
  const d = n ? (xOnly - yOnly) / n : null;
  const ci = n ? tangoInterval(xOnly, yOnly, n) : null;
  const p = n ? mcnemarExact(xOnly, yOnly) : null;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return { arms: `${x} vs ${y}`, n_pairs: n, both_pass: both, [`${x}_only`]: xOnly, [`${y}_only`]: yOnly, both_fail: neither,
    effect: d === null ? null : r3(d), ci95: ci ? [r3(ci[0]), r3(ci[1])] : null,
    ci_method: 'tango score (paired)', mcnemar_exact_p: p === null ? null : Math.round(p * 10000) / 10000,
    // the verdict is computed on these unrounded values (rounding to 3 decimals could move a bound across 0.2)
    raw: d === null || !ci || p === null ? null : { effect: d, ci95: ci, mcnemar_exact_p: p } };
}

/** erfc via Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7). */
function erfc(x: number): number {
  const z = Math.abs(x); const t = 1 / (1 + 0.3275911 * z);
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-z * z);
  return x >= 0 ? y : 2 - y;
}
/** Upper tail of chi-square with integer df (closed forms for even and odd df). */
export function chi2Sf(x: number, df: number): number {
  if (x <= 0) return 1;
  const h = x / 2; let sum = 0; let term: number;
  if (df % 2 === 0) { term = 1; for (let i = 0; i < df / 2; i++) { if (i > 0) term *= h / i; sum += term; } return Math.min(1, Math.exp(-h) * sum); }
  term = Math.sqrt(x); // x^(1/2)/1
  for (let j = 1; j <= (df - 1) / 2; j++) { if (j > 1) term *= x / (2 * j - 1); sum += term; }
  return Math.min(1, erfc(Math.sqrt(h)) + Math.sqrt(2 / Math.PI) * Math.exp(-h) * sum);
}

/**
 * Cochran's Q for k related binary conditions over complete blocks (rows = tasks, columns = conditions). The p-value uses the
 * chi-square approximation with df = k − 1 (not the exact permutation distribution); with ~20 blocks it is a descriptive omnibus.
 */
export function cochranQ(blocks: boolean[][]): { k: number; n_blocks: number; q: number | null; df: number; p: number | null; method: string } {
  const k = blocks[0]?.length ?? 0; const df = Math.max(0, k - 1);
  const method = 'chi-square approximation, df = k − 1';
  if (blocks.length === 0 || k < 2) return { k, n_blocks: blocks.length, q: null, df, p: null, method };
  const col = Array.from({ length: k }, (_, j) => blocks.filter((b) => b[j]).length);
  const rowSums = blocks.map((b) => b.filter(Boolean).length);
  const N = rowSums.reduce((a, v) => a + v, 0);
  const den = k * N - rowSums.reduce((a, v) => a + v * v, 0);
  if (den === 0) return { k, n_blocks: blocks.length, q: 0, df, p: 1, method };
  const q = ((k - 1) * (k * col.reduce((a, v) => a + v * v, 0) - N * N)) / den;
  return { k, n_blocks: blocks.length, q: Math.round(q * 1000) / 1000, df, p: Math.round(chi2Sf(q, df) * 10000) / 10000, method };
}

export type TgObservation = 'success' | 'failure' | 'INFRA_CENSORED' | 'INVALID' | 'pending';
/**
 * One experimental observation per (task, arm): retries are collapsed — the first non-infra result is the observation; a row
 * whose permitted attempts were all infra discards is INFRA_CENSORED (neither success nor failure).
 */
export function tgObservation(rowStatus: string, resultStatus: string | null): TgObservation {
  if (rowStatus === 'infra_exhausted') return 'INFRA_CENSORED';
  if (rowStatus === 'invalid') return 'INVALID';
  if (rowStatus === 'done' && (resultStatus === 'success' || resultStatus === 'failure')) return resultStatus;
  if (rowStatus === 'done') return 'INVALID';
  return 'pending';
}
const unknownOr = (n: number, known: number) => (known ? n : 'UNKNOWN' as const);

/** Interpretation per the frozen rules — only once the plan is valid and the primary comparison reached TG_MIN_TASKS pairs. */
export type TgVerdict = 'representation_supported' | 'representation_rejected' | 'inconclusive';
/** The frozen decision rule alone (B27 decision surface enumerates it): exactly one verdict per (effect, interval, p). */
export function tgVerdict(effect: number, ci95: readonly number[], p: number): TgVerdict {
  if (effect >= TG_MDE - 1e-12 /* (b − c)/n = 0.2 exactly, despite float division */ && p < TG_ALPHA) return 'representation_supported';
  if (ci95[1] < TG_MDE) return 'representation_rejected';
  return 'inconclusive';
}

export function tgInterpret(primary: { n_pairs: number; effect: number | null; ci95: number[] | null; mcnemar_exact_p: number | null; raw?: { effect: number; ci95: number[]; mcnemar_exact_p: number } | null }, ready: boolean) {
  if (!ready || primary.effect === null || !primary.ci95 || primary.mcnemar_exact_p === null) return { verdict: 'pending' as const, falsified: null, supported: null, not_tested: TG_NOT_TESTED, next_experiment: null };
  const raw = primary.raw ?? { effect: primary.effect, ci95: primary.ci95, mcnemar_exact_p: primary.mcnemar_exact_p };
  const verdict = tgVerdict(raw.effect, raw.ci95, raw.mcnemar_exact_p);
  if (verdict === 'representation_supported') return { verdict: 'representation_supported' as const,
    falsified: `H0 — the production assignment representation does not lower prod-gated success (within the gym harness)`,
    supported: `H1 — FULL_PRODUCTION lowers success vs MINIMAL_GYM by ${primary.effect} (95 % CI ${primary.ci95.join('…')}, exact McNemar p ${primary.mcnemar_exact_p}) on the same tasks`,
    not_tested: TG_NOT_TESTED, next_experiment: 'prompt-component ablation: C vs B and D vs B locate which production parts carry the effect, before any gym redesign' };
  if (verdict === 'representation_rejected') return { verdict: 'representation_rejected' as const,
    falsified: `H1 — assignment representation is not the dominant explanation of the transfer gap within the gym harness (upper 95 % bound ${primary.ci95[1]} < ${TG_MDE})`,
    supported: null, not_tested: TG_NOT_TESTED, next_experiment: '40 vs 60 max-steps on the same tasks with prompt, model, worker, runtime and evaluator fixed' };
  return { verdict: 'inconclusive' as const, falsified: null, supported: null, not_tested: TG_NOT_TESTED, next_experiment: 'extend to 40 tasks (protocol stopping rule); arms and primary comparison unchanged' };
}

/** Evidence section: per arm results, failure categories, cost/latency, and the paired A vs B (+ C, D vs B) comparisons. */
export function tg001Evidence(db: Database, env: NodeJS.ProcessEnv = process.env) {
  const manifest = tgManifest(db);
  // read-only record of earlier generations: shown, never pooled (rows are selected by the current TG_ID only)
  const gen = { experiment_id: TG_ID, generation: TG_GENERATION, prior_generations: TG_PRIOR_GENERATIONS };
  if (!manifest) return { mode: env.TG_001_MODE ?? null, ...gen, status: 'not_frozen' as const, tasks: 0, arms: [], paired: [] };
  const validity = tgAnalysisValidity(db, manifest);
  if (!validity.valid) return { mode: env.TG_001_MODE ?? null, ...gen, status: 'invalid_manifest' as const, reason: validity.reason, tasks: manifest.tasks.length, arms: [], paired: [], label: TG_LABEL };
  let rows: Array<{ task_key: string; arm: string; seq: number; status: string; result_json: string | null }> = [];
  try { rows = db.prepare('SELECT task_key, arm, seq, status, result_json FROM tg_attempts WHERE experiment_id = ?').all(TG_ID) as typeof rows; } catch { rows = []; }
  const obs = rows.map((r) => { const res = r.result_json ? JSON.parse(r.result_json) as { status: string; failure: TgFailure | null; duration_ms: number | null; metrics: TgMetrics } : null;
    return { task_key: r.task_key, arm: r.arm, position: (r.seq % TG_ARMS.length) + 1, status: tgObservation(r.status, res?.status ?? null), res }; });
  const scoredObs = obs.filter((o) => o.status === 'success' || o.status === 'failure');
  const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, v) => s + v, 0) / xs.length) : null);
  const arms = TG_ARMS.map((arm) => {
    const mine = scoredObs.filter((r) => r.arm === arm);
    const ok = mine.filter((r) => r.status === 'success').length;
    const failures: Record<string, number> = {};
    for (const r of mine) if (r.res?.failure) failures[r.res.failure] = (failures[r.res.failure] ?? 0) + 1;
    const known = (f: (m: TgMetrics) => unknown) => mine.filter((r) => r.res && f(r.res.metrics) !== null && f(r.res.metrics) !== undefined);
    const tok = known((m) => m.tokens).map((r) => r.res!.metrics.tokens as number);
    const dur = mine.map((r) => r.res?.duration_ms).filter((v): v is number => typeof v === 'number');
    const toolKnown = known((m) => m.tool_calls); const inspectedKnown = known((m) => m.files_inspected);
    return { arm, name: manifest.arms[arm], n: mine.length, success: ok, failure: mine.length - ok, rate: mine.length ? Math.round((ok / mine.length) * 1000) / 1000 : null, ci95: mine.length ? wilson(ok, mine.length) : null,
      failures, tokens_mean: tok.length ? mean(tok) : 'UNKNOWN' as const, tokens_known: tok.length, duration_ms_mean: mean(dur),
      tool_calls: unknownOr(toolKnown.reduce((a, r) => a + (r.res!.metrics.tool_calls as number), 0), toolKnown.length),
      files_inspected: unknownOr(inspectedKnown.reduce((a, r) => a + (r.res!.metrics.files_inspected as string[]).length, 0), inspectedKnown.length),
      infra_censored: obs.filter((r) => r.arm === arm && r.status === 'INFRA_CENSORED').length,
      pending: obs.filter((r) => r.arm === arm && r.status === 'pending').length,
      invalid: obs.filter((r) => r.arm === arm && r.status === 'INVALID').length };
  });
  const excluded = (x: TgArm, y: TgArm) => {
    const keys = new Set(obs.filter((o) => (o.arm === x || o.arm === y) && (o.status === 'INFRA_CENSORED' || o.status === 'INVALID')).map((o) => o.task_key));
    return { excluded_tasks: keys.size, infra_censored: obs.filter((o) => (o.arm === x || o.arm === y) && o.status === 'INFRA_CENSORED').length };
  };
  const paired = (['B', 'B', 'B'] as const).map((y, i) => { const x = (['A', 'C', 'D'] as const)[i]; const t = pairedTable(scoredObs, x, y); return { ...t, discordant: (t[`${x}_only`] as number) + (t[`${y}_only`] as number), ...excluded(x, y) }; });
  const byTask = new Map<string, Map<string, boolean>>();
  for (const o of scoredObs) { const m = byTask.get(o.task_key) ?? new Map(); m.set(o.arm, o.status === 'success'); byTask.set(o.task_key, m); }
  const complete = [...byTask.values()].filter((m) => TG_ARMS.every((a) => m.has(a)));
  const omnibus = cochranQ(complete.map((m) => TG_ARMS.map((a) => m.get(a)!)));
  // order-effect diagnostics: success by execution position within a task's block (1–4), and Cochran's Q over positions
  const byPos = new Map<string, Map<number, boolean>>();
  for (const o of scoredObs) { const m = byPos.get(o.task_key) ?? new Map(); m.set(o.position, o.status === 'success'); byPos.set(o.task_key, m); }
  const positions = [1, 2, 3, 4].map((p) => { const at = scoredObs.filter((o) => o.position === p); const ok = at.filter((o) => o.status === 'success').length;
    return { position: p, n: at.length, success: ok, rate: at.length ? Math.round((ok / at.length) * 1000) / 1000 : null,
      infra_censored: obs.filter((o) => o.position === p && o.status === 'INFRA_CENSORED').length }; });
  // censoring by arm × position (B27): a position-dependent censoring pattern is a threat to validity, reported not corrected
  const censoring = TG_ARMS.map((arm) => ({ arm, by_position: [1, 2, 3, 4].map((p) => obs.filter((o) => o.arm === arm && o.position === p && o.status === 'INFRA_CENSORED').length) }));
  const posQ = cochranQ([...byPos.values()].filter((m) => [1, 2, 3, 4].every((p) => m.has(p))).map((m) => [1, 2, 3, 4].map((p) => m.get(p)!)));
  const prior = Object.values(manifest.analysis!.prior_exposure);
  const open = obs.some((r) => r.status === 'pending');
  const primary = paired[0];
  return { mode: env.TG_001_MODE ?? null, ...gen, status: open ? 'collecting' as const : 'complete' as const, label: TG_LABEL, frozen_at: manifest.frozen_at, commit: manifest.commit, species: manifest.species,
    harness: manifest.harness, tasks: manifest.tasks.length, skipped: manifest.skipped.length, mde: TG_MDE, alpha: TG_ALPHA, interpretation_rules: TG_INTERPRETATION,
    arms, paired, omnibus_cochran_q: omnibus, order_effects: { positions, cochran_q: posQ }, censoring,
    prior_exposure: { exposed: prior.filter((p) => p.prior_exposure).length, unexposed: prior.filter((p) => !p.prior_exposure).length, prior_attempts: prior.reduce((a, p) => a + p.prior_attempt_count, 0) },
    result: tgInterpret(primary, !open && primary.n_pairs >= TG_MIN_TASKS),
    transfer_gap: 'gym 78.8 % vs production 7.0 % (workstation species, 30 d, CODEX_REPORT); TG-001 can only attribute the part due to assignment representation under the gym harness — the rest stays UNKNOWN',
    note: 'unit = (task, arm), task = block; retries collapsed (first non-infra result); primary = A vs B exact McNemar; Cochran\'s Q omnibus, then only C vs B and D vs B. All arms run the gym harness (max-steps 40); production remote makers run with 60 — the next experiment, not this one.' };
}
