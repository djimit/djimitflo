import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { GymTask } from './gym-task-miner';
import { canonicalJson, sanitizeTgMetrics } from './tg-001';
import { mcnemarOneSided } from './paired-stats';
import { exclusionReason, holdoutExclusions } from './holdout-exposure';

/**
 * CV-001 step 2 runner (docs/research/cv-001/CV-001_PROTOCOL.md, pre-registered, PREREG_SHA256 b6e1bb31…): does serving
 * Qwen3.8-27B with the discipline control vector (db1893a4…, scale 1.5) raise the share of clean successes of
 * atomic@llama-router on frozen mutant-repair gym tasks? Paired per unit (task × repeat):
 *   A baseline  router model qwen38-27b        (the production preset, unchanged)
 *   B steered   router model qwen38-27b-cvd15  (a gym-only preset: the same settings + the vector)
 * CV_001_MODE=off (default) | on. On: the first remote gym claim from a worker announcing `prod_gates` and `model_override`
 * (GYM_PROD_GATES=true) freezes 60 mutant tasks (manifest + sha256 + the block schedule, before any attempt; that claim serves
 * nothing of CV-001). Later claims serve the schedule only inside the quiet window (CV_001_WINDOW_UTC, default 0-6) and only
 * while no remote maker job is queued or claimed. The claim carries the alias; the worker forces it into every model request
 * and reports what the router served (model_check); anything short of that proof is VOID. Runs are loop_name 'cv-001' (never
 * 'evolution-gym'): no skill outcome, no diff copy, invisible to gym statistics, the breaker, tried tasks, trials and holdouts.
 * Nothing is promoted and no production maker ever gets the vector.
 */
export const cv001On = (env: NodeJS.ProcessEnv = process.env): boolean => env.CV_001_MODE === 'on';
export const CV_ID = 'cv-001';
/** loop_runs.loop_name of a CV-001 attempt — never 'evolution-gym' (the TG-001 / PL-001 provenance pattern) */
export const CV_LOOP = 'cv-001';
export const CV_PROTOCOL = 'docs/research/cv-001/CV-001_PROTOCOL.md';
export const CV_PREREG_SHA256 = 'b6e1bb318557464e49d6cef8663c5730a1d56dc396c6e471324e556faf25771c';
export const CV_VECTOR_SHA256 = 'db1893a4d12936fefedb98d117955ef6cc7b1d59c661c1e44f6eee590cda4281';
export const CV_SCALE = 1.5;
export const CV_ARMS = ['A', 'B'] as const;
export type CvArm = typeof CV_ARMS[number];
export const CV_ALIASES: Record<CvArm, string> = { A: 'qwen38-27b', B: 'qwen38-27b-cvd15' };
export const CV_ARM_NAMES: Record<CvArm, string> = { A: 'baseline (qwen38-27b)', B: 'steered (qwen38-27b-cvd15, vector 1.5)' };
export const CV_SPECIES = 'atomic@llama-router';
export const CV_TASKS = 60;
export const CV_REPEATS = 2;
export const CV_BLOCK = 6;
export const CV_ALPHA = 0.05;
export const CV_MAX_DAYS = 28;
export const CV_MAX_RETRIES = 2;
export const CV_MUTANT_TIERS = [3, 4, 5, 6] as const;
export const CV_STEP_BUDGET = 40;
/** A worker that forces a model alias into every model request and reports what the router served (scripts/gym-worker.mjs). */
export const CV_CAPABILITY = 'model_override';
export const CV_REQUIRED_CAPABILITIES = ['prod_gates', CV_CAPABILITY] as const;
export const CV_FLAGS = ['CV_001_MODE', 'CV_001_WINDOW_UTC', 'GYM_PROD_GATES', 'GYM_MAKER_TIMEOUT_MS', 'EVOLUTION_GYM_REMOTE_MAX_PER_DAY', 'HACK_DETECTOR_MODE'];
export const CV_DEFAULT_WINDOW = '0-6';
export type CvVerdict = 'ADOPT' | 'REJECT' | 'INCONCLUSIVE';

const sha = (t: string): string => createHash('sha256').update(t).digest('hex');
const DAY = 86_400_000;
const HOUR = 3_600_000;
const byHash = <T>(h: (x: T) => string) => (a: T, b: T): number => { const x = h(a); const y = h(b); return x < y ? -1 : x > y ? 1 : 0; };

/** The quiet window, whole UTC hours `start-end` (start < end). Invalid = null (nothing is served: fail closed). */
export function cvWindow(env: NodeJS.ProcessEnv = process.env): { start: number; end: number } | null {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(env.CV_001_WINDOW_UTC || CV_DEFAULT_WINDOW);
  if (!m) return null;
  const start = Number(m[1]); const end = Number(m[2]);
  return start >= 0 && start < end && end <= 24 ? { start, end } : null;
}
/** The maker budget the worker uses (GYM_MAKER_TIMEOUT_MS, default 15 min, as the orphan sweep reads it). */
export const cvMakerBudgetMs = (env: NodeJS.ProcessEnv = process.env): number => { const n = Number(env.GYM_MAKER_TIMEOUT_MS); return Number.isFinite(n) && n > 0 ? n : 900_000; };
/** Remote maker jobs waiting or running (any host); null = unreadable. */
export function makerJobsWaiting(db: Database): number | null {
  try { return (db.prepare("SELECT COUNT(*) AS n FROM remote_maker_jobs WHERE status IN ('queued', 'claimed')").get() as { n: number }).n; } catch { return null; }
}
/**
 * May a CV-001 attempt start now? Only inside the window with the whole maker budget before its end, and only while no remote
 * maker job is queued or claimed (unreadable = no).
 */
export function cvServable(db: Database, now: Date, env: NodeJS.ProcessEnv = process.env): { open: boolean; reason: string | null; window: string; maker_jobs: number | null } {
  const w = cvWindow(env); const window = env.CV_001_WINDOW_UTC || CV_DEFAULT_WINDOW;
  const jobs = makerJobsWaiting(db);
  if (!w) return { open: false, reason: `invalid CV_001_WINDOW_UTC ${JSON.stringify(window)}`, window, maker_jobs: jobs };
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const t = now.getTime();
  if (t < day + w.start * HOUR || t >= day + w.end * HOUR) return { open: false, reason: `outside the window ${w.start}:00-${w.end}:00Z`, window, maker_jobs: jobs };
  if (t + cvMakerBudgetMs(env) > day + w.end * HOUR) return { open: false, reason: 'the maker budget would end after the window', window, maker_jobs: jobs };
  if (jobs === null) return { open: false, reason: 'remote maker jobs unreadable', window, maker_jobs: jobs };
  if (jobs > 0) return { open: false, reason: `${jobs} remote maker job(s) queued or claimed`, window, maker_jobs: jobs };
  return { open: true, reason: null, window, maker_jobs: jobs };
}

export const blockFirstArm = (k: number): CvArm => (parseInt(sha(`cv-001:block:${k}`).slice(0, 2), 16) % 2 === 0 ? 'A' : 'B');
export interface CvSlot { seq: number; task_key: string; repeat: number; arm: CvArm; block: number; block_pair: number }
/**
 * The frozen schedule (protocol): units (task, repeat) ordered by sha256('cv-001:unit:' + key + '#' + repeat), cut into block
 * pairs of CV_BLOCK; each pair is two arm blocks (the first arm by sha256 parity of the pair index), the units of an arm block
 * ordered by sha256('cv-001:' + arm + ':' + key + '#' + repeat). Input order does not matter.
 */
export function cvSchedule(keys: string[]): CvSlot[] {
  const units = [...new Set(keys)].flatMap((k) => Array.from({ length: CV_REPEATS }, (_, i) => ({ task_key: k, repeat: i + 1 })))
    .sort(byHash((u) => sha(`cv-001:unit:${u.task_key}#${u.repeat}`)));
  const slots: CvSlot[] = [];
  for (let k = 0; k * CV_BLOCK < units.length; k++) {
    const block = units.slice(k * CV_BLOCK, (k + 1) * CV_BLOCK);
    const arms: CvArm[] = blockFirstArm(k) === 'A' ? ['A', 'B'] : ['B', 'A'];
    arms.forEach((arm, j) => {
      for (const u of [...block].sort(byHash((x) => sha(`cv-001:${arm}:${x.task_key}#${x.repeat}`)))) slots.push({ seq: slots.length, ...u, arm, block: 2 * k + j, block_pair: k });
    });
  }
  return slots;
}

export interface CvTask { key: string; base: string | null; source: string; tests: string[]; tier: number | null; mutant_sha256: string; order_sha256: string; task: GymTask }
export interface CvManifest {
  id: string; protocol: string; prereg_sha256: string; frozen_at: string; commit: string | null; harness: string | null; species: string; step_budget: number;
  flags: Record<string, string | null>; evaluator: { prod_gates: unknown };
  treatment: { aliases: Record<CvArm, string>; vector_sha256: string; scale: number; layer_range: null };
  tasks: CvTask[]; schedule: { repeats: number; block_size: number; units: number; slots: CvSlot[] };
  pool: { candidates: number; eligible: number; excluded: Record<string, number> };
  analysis: { hypothesis: string; primary: string; test: string; alpha: number; rules: string[]; verdicts: Record<CvVerdict, string>; max_days: number; retry_policy: string };
}

export function cvManifest(db: Database): CvManifest | null {
  try { const row = db.prepare('SELECT manifest_json FROM cv_experiments WHERE id = ?').get(CV_ID) as { manifest_json: string } | undefined; return row ? JSON.parse(row.manifest_json) as CvManifest : null; } catch { return null; }
}
export const cvManifestSha = (m: CvManifest): string => sha(canonicalJson(m));
/** Every key CV-001 froze (never served as ordinary gym work, never frozen into a holdout). */
export function cvTaskKeys(db: Database): Set<string> {
  try { return new Set((db.prepare('SELECT DISTINCT task_key AS k FROM cv_attempts').all() as Array<{ k: string }>).map((r) => r.k)); } catch { return new Set(); }
}

/**
 * Freeze once: CV_TASKS seeded mutant-repair tasks that survive the exclusions (never a holdout key of any table or epoch, a
 * TG-001 or PL-001 key, a trial-attempted or dream-exposed key, or a key with an earlier evolution-gym attempt), ordered by
 * sha256('cv-001:' + key); the first CV_TASKS are frozen with the schedule. Anything short of that freezes nothing.
 */
export function freezeCv001(db: Database, candidates: GymTask[], ctx: { species: string; commit: string | null; harness: string | null; prodGates: unknown; now: string },
  env: NodeJS.ProcessEnv = process.env): { frozen: boolean; reason?: string; manifest?: CvManifest } {
  const existing = cvManifest(db);
  if (existing) return { frozen: true, manifest: existing };
  const ex = holdoutExclusions(db);
  let prior = new Set<string>();
  try { prior = new Set((db.prepare("SELECT DISTINCT json_extract(metadata, '$.gym.commit') AS k FROM loop_runs WHERE loop_name = 'evolution-gym'").all() as Array<{ k: string | null }>).map((r) => r.k).filter((k): k is string => Boolean(k))); } catch { /* none */ }
  const excluded: Record<string, number> = {}; const bump = (r: string) => { excluded[r] = (excluded[r] ?? 0) + 1; };
  const seen = new Set<string>(); const eligible: GymTask[] = [];
  for (const t of candidates) {
    if (!t?.commit || seen.has(t.commit)) continue;
    seen.add(t.commit);
    const m = t as GymTask & { base?: string; mutant?: string; kind?: string };
    const why = (typeof m.mutant !== 'string' || m.kind === 'write_test' ? 'not a mutant-repair task' : null)
      ?? exclusionReason(ex, m) ?? (prior.has(t.commit) ? 'earlier evolution-gym attempt' : null);
    if (why) { bump(why.replace(/ (file|commit|run) .+$/, ' $1')); continue; }
    eligible.push(t);
  }
  if (eligible.length < CV_TASKS) return { frozen: false, reason: `only ${eligible.length} eligible mutant-repair tasks (need ${CV_TASKS})` };
  const tasks: CvTask[] = eligible.map((t) => ({ t, o: sha(`cv-001:${t.commit}`) })).sort((a, b) => (a.o < b.o ? -1 : a.o > b.o ? 1 : 0)).slice(0, CV_TASKS).map(({ t, o }) => {
    const m = t as GymTask & { base?: string; mutant: string; tier?: number };
    return { key: t.commit, base: m.base ?? null, source: t.source, tests: [...t.tests], tier: typeof m.tier === 'number' ? m.tier : null, mutant_sha256: sha(m.mutant), order_sha256: o, task: t };
  });
  const slots = cvSchedule(tasks.map((t) => t.key));
  const manifest: CvManifest = {
    id: CV_ID, protocol: CV_PROTOCOL, prereg_sha256: CV_PREREG_SHA256, frozen_at: ctx.now, commit: ctx.commit, harness: ctx.harness, species: ctx.species, step_budget: CV_STEP_BUDGET,
    flags: Object.fromEntries(CV_FLAGS.map((f) => [f, env[f] ?? null])), evaluator: { prod_gates: ctx.prodGates },
    treatment: { aliases: { ...CV_ALIASES }, vector_sha256: CV_VECTOR_SHA256, scale: CV_SCALE, layer_range: null },
    tasks, schedule: { repeats: CV_REPEATS, block_size: CV_BLOCK, units: tasks.length * CV_REPEATS, slots }, pool: { candidates: seen.size, eligible: eligible.length, excluded },
    analysis: {
      hypothesis: 'H-CV1: serving Qwen3.8-27B with the discipline vector at 1.5 raises the share of clean successes (atomic@llama-router, frozen mutant-repair tasks)',
      primary: 'clean success = gated verified success AND 0 edits after the first pass AND no loop AND no maker timeout; paired per unit (task x repeat); ITT (a censored slot is not clean)',
      test: 'exact one-sided McNemar p = P(X >= b), X ~ Bin(b + c, 1/2); b = B clean and A not, c = A clean and B not',
      alpha: CV_ALPHA,
      rules: ['clean success rate B - A >= +10 points and p < 0.05', 'plain success rate B - A >= -5 points', 'degenerate rate B - A <= +2 points (observed slots)', 'timeout rate B <= timeout rate A (observed slots)'],
      verdicts: { ADOPT: 'every unit complete or INVALID and all four rules hold', REJECT: 'every unit complete or INVALID and a rule fails', INCONCLUSIVE: `day ${CV_MAX_DAYS} after the first attempt before that` },
      max_days: CV_MAX_DAYS, retry_policy: `an infra discard or a VOID attempt re-serves the slot at most ${CV_MAX_RETRIES}x (3 physical attempts); then INFRA_CENSORED; a maker timeout is an observation; every physical attempt is kept`,
    },
  };
  const ins = db.prepare("INSERT INTO cv_attempts (id, experiment_id, task_key, repeat, arm, block, seq, status, retries, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)");
  db.transaction(() => {
    db.prepare('INSERT INTO cv_experiments (id, frozen_at, manifest_json, manifest_sha256) VALUES (?, ?, ?, ?)').run(CV_ID, ctx.now, JSON.stringify(manifest), cvManifestSha(manifest));
    for (const s of slots) ins.run(`${CV_ID}:${randomUUID()}`, CV_ID, s.task_key, s.repeat, s.arm, s.block, s.seq, ctx.now);
  })();
  return { frozen: true, manifest };
}

/** A refused freeze is recorded (the caller retries at most hourly), so the evidence can say why nothing is frozen. */
export function recordCvFreezeRefusal(db: Database, reason: string, now: string): void {
  try {
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, model, created_at)
      VALUES (?, 'cv_001_freeze', 'experiment', ?, ?, 'on', 'refused', ?, '{}', 'policy', ?)`).run(randomUUID(), CV_ID, sha(reason).slice(0, 16), reason.slice(0, 300), now);
  } catch { /* bookkeeping */ }
}
export function lastCvFreezeRefusal(db: Database): { reason: string; at: string } | null {
  try { return (db.prepare("SELECT reason, created_at AS at FROM judgments WHERE judgment = 'cv_001_freeze' ORDER BY created_at DESC LIMIT 1").get() as { reason: string; at: string } | undefined) ?? null; } catch { return null; }
}

/** Earliest physical attempt (a claim); null = none yet; undefined = unreadable. */
export function cvFirstAttempt(db: Database): string | null | undefined {
  try { return (db.prepare('SELECT MIN(first_claimed_at) AS t FROM cv_attempts WHERE experiment_id = ?').get(CV_ID) as { t: string | null }).t ?? null; } catch { return undefined; }
}
/** The analysis may only run on the manifest frozen before the data: its stored sha256 must match and it must predate the first attempt. */
export function cvManifestValidity(db: Database, m: CvManifest): { valid: boolean; reason: string | null } {
  let row: { manifest_sha256: string | null } | undefined;
  try { row = db.prepare('SELECT manifest_sha256 FROM cv_experiments WHERE id = ?').get(m.id) as typeof row; } catch { return { valid: false, reason: 'manifest fingerprint unreadable' }; }
  if (!row?.manifest_sha256) return { valid: false, reason: 'no stored manifest fingerprint' };
  if (cvManifestSha(m) !== row.manifest_sha256) return { valid: false, reason: 'manifest changed after freeze' };
  if (m.treatment.vector_sha256 !== CV_VECTOR_SHA256 || m.treatment.scale !== CV_SCALE || m.treatment.aliases.A !== CV_ALIASES.A || m.treatment.aliases.B !== CV_ALIASES.B) return { valid: false, reason: 'manifest treatment is not the protocol treatment' };
  const first = cvFirstAttempt(db);
  if (first === undefined) return { valid: false, reason: 'attempt history unreadable' };
  if (first && m.frozen_at >= first) return { valid: false, reason: `manifest (${m.frozen_at}) not frozen before the first physical attempt (${first})` };
  return { valid: true, reason: null };
}

export interface CvClaim { attempt_id: string; arm: CvArm; repeat: number; block: number; task: GymTask; alias: string }
/** The next pending slot, lowest seq first, marked claimed for this run; null when stopped or nothing is pending. */
export function claimCv001(db: Database, m: CvManifest, runId: string, now: string): CvClaim | null {
  if (m.id !== CV_ID || !cvManifestValidity(db, m).valid) return null;
  if (cvState(db, m, Date.parse(now)).verdict) return null;
  const row = db.prepare("SELECT id, task_key, repeat, arm, block FROM cv_attempts WHERE experiment_id = ? AND status = 'pending' ORDER BY seq LIMIT 1").get(CV_ID) as
    { id: string; task_key: string; repeat: number; arm: CvArm; block: number } | undefined;
  if (!row) return null;
  const entry = m.tasks.find((t) => t.key === row.task_key);
  if (!entry) return null;
  db.prepare("UPDATE cv_attempts SET status = 'claimed', run_id = ?, updated_at = ?, first_claimed_at = COALESCE(first_claimed_at, ?) WHERE id = ?").run(runId, now, now, row.id);
  return { attempt_id: row.id, arm: row.arm, repeat: row.repeat, block: row.block, task: entry.task, alias: m.treatment.aliases[row.arm] };
}
/** What the claim records on the run (gym.cv): the arm, the slot and the alias the worker must report it used. */
export const cvClaimMeta = (c: CvClaim) => ({ experiment: CV_ID, arm: c.arm, repeat: c.repeat, block: c.block, attempt_id: c.attempt_id, alias: c.alias });
export type CvClaimMeta = ReturnType<typeof cvClaimMeta>;

/** The worker's model_check, sanitised: only known fields with sane types; anything missing stays null. */
export interface CvModelCheck {
  alias: string | null; requests: number | null; forced: number | null; unforced: number | null; served_models: string[] | null; http_errors: number | null;
  router: { listed: boolean; status: string | null; layer_range: string | null; control_vectors: Array<{ path: string; scale: number | null; sha256: string | null }> } | null;
  transcript: { tool_calls: number | null; broken_tool_calls: number | null; loop: boolean | null; post_pass_edits: number | null; pass_seen: boolean | null } | null;
}
const n0 = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
export function sanitizeModelCheck(v: unknown): CvModelCheck | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const m = v as Record<string, unknown>;
  const r = m.router && typeof m.router === 'object' && !Array.isArray(m.router) ? m.router as Record<string, unknown> : null;
  const t = m.transcript && typeof m.transcript === 'object' && !Array.isArray(m.transcript) ? m.transcript as Record<string, unknown> : null;
  return {
    alias: str(m.alias, 80), requests: n0(m.requests), forced: n0(m.forced), unforced: n0(m.unforced), http_errors: n0(m.http_errors),
    served_models: Array.isArray(m.served_models) ? m.served_models.map(String).slice(0, 10).map((s) => s.slice(0, 80)) : null,
    router: r ? { listed: r.listed === true, status: str(r.status, 40), layer_range: str(r.layer_range, 40),
      control_vectors: Array.isArray(r.control_vectors) ? r.control_vectors.slice(0, 5).map((c) => { const x = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
        return { path: str(x.path, 300) ?? '', scale: typeof x.scale === 'number' && Number.isFinite(x.scale) ? x.scale : null, sha256: typeof x.sha256 === 'string' && /^[0-9a-f]{64}$/.test(x.sha256) ? x.sha256 : null }; }) : [] } : null,
    transcript: t ? { tool_calls: n0(t.tool_calls), broken_tool_calls: n0(t.broken_tool_calls), loop: bool(t.loop), post_pass_edits: n0(t.post_pass_edits), pass_seen: bool(t.pass_seen) } : null,
  };
}

/**
 * Why a scored CV-001 attempt is VOID (null = it counts): the oracle must have run the gates, and the delivery proof must hold
 * — the worker used the claimed alias, forced it into at least one request and into every one, the router answered under that
 * alias only, its listing for the alias was read, arm B carries exactly the protocol vector (scale 1.5, file digest db1893a4…,
 * no layer range) and arm A none, and the transcript counts are present.
 */
export function cvVoid(cv: CvClaimMeta, gated: boolean, status: string, prodGates: Record<string, string> | undefined, mc: CvModelCheck | null): string | null {
  if (status !== 'success' && status !== 'failure' && status !== 'quarantined') return null;
  if (!gated) return 'oracle: claimed without the production gates';
  if (status === 'success' && !prodGates) return 'oracle: gated success without per-check prod gate results (ELIGIBLE_GATED)';
  if (!mc) return 'delivery: the worker reported no model check';
  if (mc.alias !== cv.alias) return `delivery: the worker used model ${JSON.stringify(mc.alias)}, the claim named ${cv.alias}`;
  if (!mc.forced) return 'delivery: no model request went through the forced route';
  if (mc.unforced !== 0) return `delivery: ${mc.unforced ?? 'unknown'} model request(s) reached the router without the alias`;
  if (!mc.served_models?.length) return 'delivery: the router named no model in its responses';
  const other = mc.served_models.find((s) => s !== cv.alias);
  if (other) return `delivery: the router served ${other}, not ${cv.alias}`;
  if (!mc.router?.listed) return 'delivery: the router listing for the alias was not read';
  if (mc.router.layer_range) return `delivery: the alias has a control-vector layer range ${mc.router.layer_range}`;
  const vs = mc.router.control_vectors;
  if (cv.arm === 'B') {
    if (vs.length !== 1) return `delivery: arm B alias carries ${vs.length} control vectors, not 1`;
    if (vs[0].scale !== CV_SCALE) return `delivery: arm B vector scale ${vs[0].scale ?? 'unknown'}, not ${CV_SCALE}`;
    if (vs[0].sha256 !== CV_VECTOR_SHA256) return vs[0].sha256 ? `delivery: arm B vector digest ${vs[0].sha256.slice(0, 12)}… is not the protocol's` : 'delivery: arm B vector digest unknown';
  } else if (vs.length) return 'delivery: arm A alias carries a control vector';
  const t = mc.transcript;
  if (!t || t.tool_calls === null || t.broken_tool_calls === null || t.loop === null || t.post_pass_edits === null) return 'transcript: the worker could not read the maker transcript';
  return null;
}

/** A CV-001 maker timeout is an observation (protocol amendment 1), not infra: the worker discards it as infra when nothing changed. */
export const isMakerTimeoutDiscard = (status: string, reason: string, tgMetrics: unknown): boolean =>
  status === 'discarded' && /^infra: maker crashed or timed out/.test(reason) && sanitizeTgMetrics(tgMetrics).termination === 'timeout';
export const CV_TIMEOUT_REASON = 'maker timeout (CV-001 observation)';

export interface CvResult {
  run_id: string; status: string; reason: string; void: string | null;
  plain: boolean; clean: boolean; timeout: boolean; degenerate: boolean | null; loop: boolean | null; post_pass_edits: number | null;
  tool_calls: number | null; broken_tool_calls: number | null; http_errors: number | null; termination: string | null; maker_ms: number | null; tokens: number | null; at: string;
}
export function cvResult(input: { runId: string; status: string; reason: string; void: string | null; prodGates: Record<string, string> | undefined; modelCheck: CvModelCheck | null;
  tgMetrics?: unknown; tokens: number | null; now: string }): CvResult {
  const m = sanitizeTgMetrics(input.tgMetrics); const t = input.modelCheck?.transcript ?? null; const http = input.modelCheck?.http_errors ?? null;
  const plain = input.status === 'success' && !input.void && Boolean(input.prodGates);
  const timeout = m.termination === 'timeout';
  const loop = t?.loop ?? null; const ppe = t?.post_pass_edits ?? null; const broken = t?.broken_tool_calls ?? null;
  return { run_id: input.runId, status: input.status, reason: input.reason.slice(0, 200), void: input.void, plain, clean: plain && ppe === 0 && loop === false && !timeout, timeout,
    degenerate: broken === null || http === null ? null : broken > 0 || http > 0, loop, post_pass_edits: ppe, tool_calls: t?.tool_calls ?? null, broken_tool_calls: broken, http_errors: http,
    termination: m.termination ?? null, maker_ms: m.maker_ms ?? null, tokens: input.tokens, at: input.now };
}

/**
 * A run's result settles its slot. An infra discard or a VOID attempt re-serves the slot at most CV_MAX_RETRIES times, then it
 * is INFRA_CENSORED ('censored'). A task discard ('task:', e.g. the mutant survives) makes every slot of the task INVALID.
 * Anything else is the observation ('done'). Every physical attempt stays in history_json.
 */
export function recordCv001(db: Database, attemptId: string, r: CvResult): void {
  const row = db.prepare('SELECT task_key, status, retries, history_json FROM cv_attempts WHERE id = ? AND run_id = ? AND experiment_id = ?').get(attemptId, r.run_id, CV_ID) as
    { task_key: string; status: string; retries: number; history_json: string | null } | undefined;
  if (!row || row.status !== 'claimed') return;
  const history = [...(row.history_json ? JSON.parse(row.history_json) as unknown[] : []), r];
  const retry = (r.status === 'discarded' && /^infra:/.test(r.reason)) || r.void !== null;
  const status = retry ? (row.retries < CV_MAX_RETRIES ? 'pending' : 'censored') : r.status === 'discarded' ? 'invalid' : 'done';
  db.prepare("UPDATE cv_attempts SET status = ?, retries = ?, result_json = ?, history_json = ?, run_id = CASE WHEN ? = 'pending' THEN NULL ELSE run_id END, updated_at = ? WHERE id = ?")
    .run(status, retry && row.retries < CV_MAX_RETRIES ? row.retries + 1 : row.retries, JSON.stringify(r), JSON.stringify(history), status, r.at, attemptId);
  if (status === 'invalid') {
    db.prepare("UPDATE cv_attempts SET status = 'invalid', result_json = ?, updated_at = ? WHERE experiment_id = ? AND task_key = ? AND id <> ? AND status = 'pending'")
      .run(JSON.stringify({ status: 'discarded', reason: `task invalid: ${r.reason}`.slice(0, 200), at: r.at }), r.at, CV_ID, row.task_key, attemptId);
  }
}

interface Row { task_key: string; repeat: number; arm: CvArm; seq: number; status: string; retries: number; run_id: string | null; result: CvResult | null; history: CvResult[]; updated_at: string }
function rows(db: Database): Row[] {
  try {
    return (db.prepare('SELECT task_key, repeat, arm, seq, status, retries, run_id, result_json, history_json, updated_at FROM cv_attempts WHERE experiment_id = ? ORDER BY seq').all(CV_ID) as
      Array<Omit<Row, 'result' | 'history'> & { result_json: string | null; history_json: string | null }>)
      .map(({ result_json, history_json, ...r }) => ({ ...r, result: result_json ? JSON.parse(result_json) as CvResult : null, history: history_json ? JSON.parse(history_json) as CvResult[] : [] }));
  } catch { return []; }
}

/** A completed slot: its observation, or null = INFRA_CENSORED (ITT: neither clean nor plain; left out of the observed rates). */
export interface CvPair { task_key: string; repeat: number; A: CvResult | null; B: CvResult | null }
const rate = (k: number, n: number): number | null => (n ? Math.round((k / n) * 1000) / 1000 : null);
/**
 * The paired analysis and the frozen decision rule (integer arithmetic, so +10 points is exactly 10 · Δ ≥ n): ADOPT iff all four
 * rules hold. Rules 3–4 use the observed (uncensored) slots per arm; no observation in an arm = the rule does not hold.
 */
export function cvPaired(pairs: CvPair[]) {
  const n = pairs.length;
  const clean = (r: CvResult | null) => Boolean(r?.clean); const plain = (r: CvResult | null) => Boolean(r?.plain);
  let both = 0; let b = 0; let c = 0; let neither = 0;
  for (const p of pairs) { const a = clean(p.A); const x = clean(p.B); if (a && x) both++; else if (x) b++; else if (a) c++; else neither++; }
  const cleanA = both + c; const cleanB = both + b;
  const plainA = pairs.filter((p) => plain(p.A)).length; const plainB = pairs.filter((p) => plain(p.B)).length;
  const obs = (arm: CvArm) => pairs.map((p) => p[arm]).filter((r): r is CvResult => r !== null);
  const oA = obs('A'); const oB = obs('B');
  const degA = oA.filter((r) => r.degenerate).length; const degB = oB.filter((r) => r.degenerate).length;
  const toA = oA.filter((r) => r.timeout).length; const toB = oB.filter((r) => r.timeout).length;
  const p = n ? mcnemarOneSided(b, c) : null;
  const rules = n ? {
    clean_plus_10_and_significant: 10 * (cleanB - cleanA) >= n && (p as number) < CV_ALPHA,
    plain_drop_at_most_5: 20 * (plainB - plainA) >= -n,
    degenerate_rise_at_most_2: oA.length > 0 && oB.length > 0 && 50 * (degB * oA.length - degA * oB.length) <= oA.length * oB.length,
    timeouts_not_higher: oA.length > 0 && oB.length > 0 && toB * oA.length <= toA * oB.length,
  } : null;
  return { n_pairs: n, both_clean: both, b_only_B: b, c_only_A: c, neither_clean: neither, clean_A: n ? cleanA : null, clean_B: n ? cleanB : null,
    clean_rate_A: rate(cleanA, n), clean_rate_B: rate(cleanB, n), p_one_sided: p, plain_rate_A: rate(plainA, n), plain_rate_B: rate(plainB, n),
    observed: { A: oA.length, B: oB.length }, degenerate_rate_A: rate(degA, oA.length), degenerate_rate_B: rate(degB, oB.length),
    timeout_rate_A: rate(toA, oA.length), timeout_rate_B: rate(toB, oB.length), rules, adopt: rules ? Object.values(rules).every(Boolean) : null };
}

/** The whole experiment state: pairs (task × repeat), the analysis, the stop rule and the verdict (null while collecting). */
export function cvState(db: Database, m: CvManifest, now = Date.now()) {
  const frozen = new Set(m.tasks.map((t) => t.key));
  const all = rows(db).filter((r) => frozen.has(r.task_key));
  const units = new Map<string, Partial<Record<CvArm, Row>>>();
  for (const r of all) { const k = `${r.task_key}#${r.repeat}`; const u = units.get(k) ?? {}; u[r.arm] = r; units.set(k, u); }
  const final = (r?: Row) => r?.status === 'done' || r?.status === 'censored';
  const obs = (r: Row) => (r.status === 'done' ? r.result : null);
  const completed: CvPair[] = []; let invalid = 0; let open = 0;
  for (const [, u] of units) {
    if (u.A?.status === 'invalid' || u.B?.status === 'invalid') { invalid++; continue; }
    if (u.A && u.B && final(u.A) && final(u.B)) completed.push({ task_key: u.A.task_key, repeat: u.A.repeat, A: obs(u.A), B: obs(u.B) });
    else open++;
  }
  const primary = cvPaired(completed);
  const sensitivity = cvPaired(completed.filter((p) => p.A && p.B));
  const repeat1 = cvPaired(completed.filter((p) => p.repeat === 1));
  const first = cvFirstAttempt(db) ?? null;
  const dayLimit = first ? new Date(Date.parse(first) + CV_MAX_DAYS * DAY).toISOString() : null;
  const pastDay = dayLimit !== null && now >= Date.parse(dayLimit);
  const verdict: CvVerdict | null = open === 0 && completed.length > 0 ? (primary.adopt ? 'ADOPT' : 'REJECT') : pastDay ? 'INCONCLUSIVE' : null;
  const reason = verdict === 'INCONCLUSIVE' ? `day ${CV_MAX_DAYS} (${dayLimit}) with ${open} unit(s) open` : verdict ? `every unit complete or INVALID (${completed.length} pairs, ${invalid} invalid)` : null;
  return { rows: all, completed, invalid_units: invalid, open_units: open, primary, sensitivity, repeat1, stop: { first_attempt_at: first, day_limit_at: dayLimit, stopped: verdict !== null, reason }, verdict };
}

/**
 * The verdict is recorded once on the experiment row; REJECT also records a negative-evidence draft (judgment
 * negative_evidence_draft) the operator adds to NEGATIVE_EVIDENCE.yaml. Nothing is promoted; no production maker is touched.
 */
export function applyCv001Verdict(db: Database, m: CvManifest, state: ReturnType<typeof cvState>, now: string): boolean {
  if (!state.verdict) return false;
  const p = state.primary;
  const summary = `CV-001 ${state.verdict}: ${p.n_pairs} pairs, clean ${p.clean_B ?? 'n/a'} (B) vs ${p.clean_A ?? 'n/a'} (A), b ${p.b_only_B} vs c ${p.c_only_A}, one-sided McNemar p ${p.p_one_sided === null ? 'not computed' : p.p_one_sided.toPrecision(3)}; ${state.stop.reason ?? ''}`.trim();
  const record = { experiment: CV_ID, verdict: state.verdict, decided_at: now, reason: summary, manifest_sha256: cvManifestSha(m), rules: p.rules, promoted: false,
    production_delivery: 'never through CV-001; any wider rollout is a separate operator decision' };
  let applied = false;
  db.transaction(() => {
    applied = db.prepare('UPDATE cv_experiments SET verdict_json = ? WHERE id = ? AND verdict_json IS NULL').run(JSON.stringify(record), CV_ID).changes > 0;
    if (applied && state.verdict === 'REJECT') {
      const draft = { id: 'NE-CV-001 (draft)', title: 'Discipline control vector (scale 1.5) on the gym repair maker', hypothesis: m.analysis.hypothesis, verdict: 'REJECT', decided_on: now.slice(0, 10),
        conditions: `${m.species}, ${m.tasks.length} frozen mutant-repair tasks x ${CV_REPEATS} repeats, manifest sha256 ${cvManifestSha(m)}`, result: summary,
        evidence: [CV_PROTOCOL, `PREREG_SHA256 ${CV_PREREG_SHA256}`, `vector sha256 ${CV_VECTOR_SHA256}`], reopen_condition: 'A new pre-registration with another scale, layer range or vector reaches its own verdict.' };
      db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, model, created_at)
        VALUES (?, 'negative_evidence_draft', 'experiment', ?, ?, 'on', 'draft', ?, ?, 'policy', ?)`).run(randomUUID(), CV_ID, sha(JSON.stringify(draft)).slice(0, 16), summary.slice(0, 300), JSON.stringify(draft), now);
    }
  })();
  return applied;
}
function recordedVerdict(db: Database): unknown {
  try { const r = db.prepare('SELECT verdict_json FROM cv_experiments WHERE id = ?').get(CV_ID) as { verdict_json: string | null } | undefined; return r?.verdict_json ? JSON.parse(r.verdict_json) : null; } catch { return null; }
}

const median = (xs: number[]): number | null => { if (!xs.length) return null; const s = [...xs].sort((x, y) => x - y); const k = Math.floor(s.length / 2); return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
/** Evidence `cv_001`: the window, the frozen set, pairs done / target, per-arm outcomes, the analysis, the decision rule and the verdict. */
export function cv001Evidence(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const base = {
    mode: cv001On(env) ? 'on' as const : 'off' as const, experiment_id: CV_ID, protocol: CV_PROTOCOL, prereg_sha256: CV_PREREG_SHA256, loop_name: CV_LOOP,
    treatment: { aliases: CV_ALIASES, vector_sha256: CV_VECTOR_SHA256, scale: CV_SCALE }, serving: cvServable(db, new Date(now), env),
    targets: { tasks: CV_TASKS, repeats: CV_REPEATS, units: CV_TASKS * CV_REPEATS, block_size: CV_BLOCK, alpha: CV_ALPHA, max_days: CV_MAX_DAYS },
  };
  const empty = { manifest: null, pairs: null, arms: [], primary: null, sensitivity: null, repeat1: null, stop: null, verdict: null, recorded_verdict: null, runs: [] };
  const m = cvManifest(db);
  if (!m) return { ...base, status: 'not_frozen' as const, freeze_refused: lastCvFreezeRefusal(db), ...empty };
  const validity = cvManifestValidity(db, m);
  const manifest = { frozen_at: m.frozen_at, sha256: cvManifestSha(m), tasks: m.tasks.length, units: m.schedule.units, species: m.species, commit: m.commit, harness: m.harness, pool: m.pool,
    by_tier: Object.fromEntries([...new Set(m.tasks.map((t) => t.tier))].filter((t): t is number => t !== null).sort().map((t) => [String(t), m.tasks.filter((x) => x.tier === t).length])),
    valid: validity.valid, reason: validity.reason };
  if (!validity.valid) return { ...base, status: 'invalid_manifest' as const, freeze_refused: null, ...empty, manifest };
  const s = cvState(db, m, now);
  const arms = CV_ARMS.map((arm) => {
    const mine = s.rows.filter((r) => r.arm === arm);
    const done = mine.filter((r) => r.status === 'done' && r.result).map((r) => r.result!);
    const physical = mine.flatMap((r) => r.history);
    const tokens = done.map((r) => r.tokens).filter((t): t is number => typeof t === 'number' && t > 0);
    return { arm, name: CV_ARM_NAMES[arm], alias: CV_ALIASES[arm], observations: done.length, clean: done.filter((r) => r.clean).length, plain: done.filter((r) => r.plain).length,
      timeouts: done.filter((r) => r.timeout).length, degenerate: done.filter((r) => r.degenerate).length, loops: done.filter((r) => r.loop).length,
      post_pass_edits: done.reduce((a, r) => a + (r.post_pass_edits ?? 0), 0), censored: mine.filter((r) => r.status === 'censored').length,
      invalid: mine.filter((r) => r.status === 'invalid').length, pending: mine.filter((r) => r.status === 'pending' || r.status === 'claimed').length,
      physical_attempts: physical.length, void_attempts: physical.filter((h) => h.void).length, infra_attempts: physical.filter((h) => h.status === 'discarded' && /^infra:/.test(h.reason)).length,
      maker_ms_median: median(done.map((r) => r.maker_ms).filter((x): x is number => typeof x === 'number')),
      tokens: { known: tokens.length, unknown: done.length - tokens.length } };
  });
  const runs = s.rows.flatMap((r) => r.history.map((h) => ({ task_key: r.task_key, repeat: r.repeat, arm: r.arm, run_id: h.run_id, status: h.status, reason: h.reason, void: h.void, clean: h.clean, at: h.at })))
    .sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0)).slice(0, 25);
  const status = s.verdict ? 'stopped' as const : s.open_units ? (base.serving.open ? 'collecting' as const : 'waiting_window' as const) : 'exhausted' as const;
  return { ...base, status, freeze_refused: null, manifest, pairs: { done: s.completed.length, open: s.open_units, invalid_units: s.invalid_units, target: m.schedule.units },
    arms, primary: s.primary.n_pairs ? s.primary : null, sensitivity: s.sensitivity.n_pairs ? s.sensitivity : null, repeat1: s.repeat1.n_pairs ? s.repeat1 : null,
    stop: s.stop, verdict: s.verdict, recorded_verdict: recordedVerdict(db), runs };
}
