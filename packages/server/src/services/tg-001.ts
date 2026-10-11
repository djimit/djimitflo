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
export const TG_ID = 'tg-001';
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
  id: string; frozen_at: string; commit: string | null; species: string; harness: string | null; evaluator: { oracle: string; prod_gates: unknown };
  flags: Record<string, string | null>; seed: number; arms: Record<TgArm, string>; c_removed: AssignmentOmit[];
  tasks: Array<{ key: string; lane: string; run_id: string; base: string; source: string; target: string; prior_gym_attempts: number; prompt_sha256: Record<TgArm, string>; prompts: Record<TgArm, string>; task: FailureTask }>;
  skipped: Array<{ key: string; reason: string }>;
}
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
    id: TG_ID, frozen_at: ctx.now, commit: ctx.commit, species: ctx.species, harness: ctx.harness, evaluator: { oracle: WRITE_TEST_ORACLE, prod_gates: ctx.prodGates },
    flags: Object.fromEntries(TG_FLAGS.map((f) => [f, env[f] ?? null])), seed: TG_SEED,
    arms: { A: 'MINIMAL_GYM', B: 'FULL_PRODUCTION', C: 'CONTROLLED_PRODUCTION', D: 'STRUCTURED_MINIMAL' }, c_removed: TG_C_REMOVED, tasks: picked, skipped,
  };
  const ins = db.prepare("INSERT INTO tg_attempts (id, experiment_id, task_key, arm, seq, status, retries, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)");
  db.transaction(() => {
    db.prepare('INSERT INTO tg_experiments (id, frozen_at, manifest_json) VALUES (?, ?, ?)').run(TG_ID, ctx.now, JSON.stringify(manifest));
    for (const s of tgSchedule(picked.map((p) => p.key))) ins.run(randomUUID(), TG_ID, s.task_key, s.arm, s.seq, ctx.now);
  })();
  return { frozen: true, manifest };
}

/** The next queued (task, arm), oldest seq first; it is marked claimed for this run. */
export function claimTg001(db: Database, manifest: TgManifest, runId: string, now: string): { attempt_id: string; arm: TgArm; task: FailureTask; prompt: string } | null {
  const row = db.prepare("SELECT id, task_key, arm FROM tg_attempts WHERE experiment_id = ? AND status = 'pending' ORDER BY seq LIMIT 1").get(TG_ID) as { id: string; task_key: string; arm: TgArm } | undefined;
  if (!row) return null;
  const entry = manifest.tasks.find((t) => t.key === row.task_key);
  if (!entry) return null;
  db.prepare("UPDATE tg_attempts SET status = 'claimed', run_id = ?, updated_at = ? WHERE id = ?").run(runId, now, row.id);
  return { attempt_id: row.id, arm: row.arm, task: entry.task, prompt: entry.prompts[row.arm] };
}

export type TgFailure = 'UNDERSTANDING_FAILURE' | 'PLANNING_FAILURE' | 'CONTEXT_FAILURE' | 'TOOL_FAILURE' | 'IMPLEMENTATION_FAILURE' | 'TEST_FAILURE' | 'TIMEOUT' | 'INFRASTRUCTURE_FAILURE' | 'EVALUATOR_FAILURE' | 'UNKNOWN';
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
 * cleanly within 60 s and changed nothing (the #609 'Ready. What would you like me to do?' pattern); otherwise UNKNOWN.
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
    return 'UNKNOWN';
  }
  if (/tests still red|no seeded mutant|mutant|does not import|mock|expect|skip/i.test(reason)) return 'TEST_FAILURE';
  return 'UNKNOWN';
}

/** A run's result settles its attempt; an infra discard (or a timeout without a change) re-queues it up to TG_MAX_INFRA_RETRIES. */
export function recordTg001(db: Database, attemptId: string, runId: string, result: { status: string; reason: string; durationMs?: unknown; tg_metrics?: unknown }, now: string): void {
  const row = db.prepare('SELECT status, retries, history_json FROM tg_attempts WHERE id = ? AND run_id = ?').get(attemptId, runId) as { status: string; retries: number; history_json: string | null } | undefined;
  if (!row || row.status !== 'claimed') return;
  const metrics = sanitizeTgMetrics(result.tg_metrics);
  const failure = classifyTgFailure(result.status, String(result.reason || ''), metrics);
  const rec = { run_id: runId, status: result.status, reason: String(result.reason || '').slice(0, 200), duration_ms: num(result.durationMs), failure, metrics, at: now };
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

/** Paired comparison x vs y over tasks where both arms produced a scored (success/failure) result. */
export function pairedTable(rows: Array<{ task_key: string; arm: string; status: string }>, x: TgArm, y: TgArm) {
  const by = new Map<string, Record<string, boolean>>();
  for (const r of rows) if (r.status === 'success' || r.status === 'failure') { const m = by.get(r.task_key) ?? {}; m[r.arm] = r.status === 'success'; by.set(r.task_key, m); }
  let both = 0; let xOnly = 0; let yOnly = 0; let neither = 0;
  for (const m of by.values()) { if (!(x in m) || !(y in m)) continue; if (m[x] && m[y]) both++; else if (m[x]) xOnly++; else if (m[y]) yOnly++; else neither++; }
  const n = both + xOnly + yOnly + neither;
  const d = n ? (xOnly - yOnly) / n : null;
  const se = n ? Math.sqrt(Math.max(0, xOnly + yOnly - ((xOnly - yOnly) ** 2) / n)) / n : null;
  return { arms: `${x} vs ${y}`, n_pairs: n, both_pass: both, [`${x}_only`]: xOnly, [`${y}_only`]: yOnly, both_fail: neither,
    effect: d === null ? null : Math.round(d * 1000) / 1000, ci95: d === null || se === null ? null : [Math.round((d - 1.96 * se) * 1000) / 1000, Math.round((d + 1.96 * se) * 1000) / 1000],
    ci_method: 'wald (paired)', mcnemar_exact_p: n ? Math.round(mcnemarExact(xOnly, yOnly) * 10000) / 10000 : null };
}

/** Evidence section: per arm results, failure categories, cost/latency, and the paired A vs B (+ C, D vs B) comparisons. */
export function tg001Evidence(db: Database, env: NodeJS.ProcessEnv = process.env) {
  const manifest = tgManifest(db);
  if (!manifest) return { mode: env.TG_001_MODE ?? null, status: 'not_frozen' as const, tasks: 0, arms: [], paired: [] };
  let rows: Array<{ task_key: string; arm: string; status: string; result_json: string | null }> = [];
  try { rows = db.prepare('SELECT task_key, arm, status, result_json FROM tg_attempts WHERE experiment_id = ?').all(TG_ID) as typeof rows; } catch { rows = []; }
  const scored = rows.map((r) => { const res = r.result_json ? JSON.parse(r.result_json) as { status: string; failure: TgFailure | null; duration_ms: number | null; metrics: TgMetrics } : null;
    return { task_key: r.task_key, arm: r.arm, status: r.status === 'done' && res ? res.status : r.status, res }; });
  const arms = TG_ARMS.map((arm) => {
    const mine = scored.filter((r) => r.arm === arm && (r.status === 'success' || r.status === 'failure'));
    const ok = mine.filter((r) => r.status === 'success').length;
    const failures: Record<string, number> = {};
    for (const r of mine) if (r.res?.failure) failures[r.res.failure] = (failures[r.res.failure] ?? 0) + 1;
    const tok = mine.map((r) => r.res?.metrics.tokens).filter((v): v is number => typeof v === 'number');
    const dur = mine.map((r) => r.res?.duration_ms).filter((v): v is number => typeof v === 'number');
    const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, v) => s + v, 0) / xs.length) : null);
    return { arm, name: manifest.arms[arm], n: mine.length, success: ok, rate: mine.length ? Math.round((ok / mine.length) * 1000) / 1000 : null, ci95: mine.length ? wilson(ok, mine.length) : null,
      failures, tokens_mean: mean(tok), tokens_known: tok.length, duration_ms_mean: mean(dur),
      pending: scored.filter((r) => r.arm === arm && (r.status === 'pending' || r.status === 'claimed')).length,
      invalid: scored.filter((r) => r.arm === arm && (r.status === 'invalid' || r.status === 'infra_exhausted')).length };
  });
  const paired = [pairedTable(scored, 'A', 'B'), pairedTable(scored, 'C', 'B'), pairedTable(scored, 'D', 'B')];
  const open = scored.some((r) => r.status === 'pending' || r.status === 'claimed');
  return { mode: env.TG_001_MODE ?? null, status: open ? 'collecting' as const : 'complete' as const, frozen_at: manifest.frozen_at, commit: manifest.commit, species: manifest.species,
    harness: manifest.harness, tasks: manifest.tasks.length, skipped: manifest.skipped.length, arms, paired,
    note: 'primary = A vs B (McNemar exact, two-sided); C and D vs B decompose the representation. Gym harness for all arms (max-steps 40); production remote makers run with max-steps 60 — an environment factor for the next experiment, not this one.' };
}
