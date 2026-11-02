import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { GymTask } from './gym-task-miner';
import { canonicalJson, oneLine, sanitizeTgMetrics, type TgMetrics } from './tg-001';
import { ePaired, mcnemarOneSided } from './paired-stats';
import { exclusionReason, holdoutExclusions } from './holdout-exposure';
import { PROCEDURE_ID, ensureProcedures, linesSha256, procedure, selectProcedure, taskFeatures, type ApplicabilityContract, type ClauseName, type Procedure } from './procedure-selector';

/**
 * PL-001 runner (docs/research/procedure-loop/PL-001_PROTOCOL.md, pre-registered, PREREG_SHA256 fa136ae5…): does the frozen
 * procedure ts-build-error-repair-v1 (5 lines, lines_sha256 6dddbba1…) raise the share of gated verified successes of
 * atomic@llama-router on repair tasks the procedure applies to? Paired by task:
 *   A baseline   today's gym goal, no lines
 *   B candidate  today's gym goal + the five lines, delivered as genome strategy lines are today (claim.genome.lines)
 * PL_001_MODE=off (default) | on. On: the first remote gym claim from a worker announcing `prod_gates` and `procedure_lines`
 * (with GYM_PROD_GATES=true) freezes 75 applicable tasks (manifest + sha256, before any attempt; that claim serves nothing of
 * PL-001); later claims serve the pairs in manifest order, A or B first per sha256('pl-001:' + key). Runs are loop_name
 * 'pl-001' (never 'evolution-gym'), earn no skill outcome and no gym_attempt_diffs copy, so no gym statistic, breaker, trial,
 * holdout or fitness reader sees them. The start condition (protocol) gates serving: both trial genomes settled, or an
 * operator cap share PL_001_CAP_SHARE (0–1 of EVOLUTION_GYM_REMOTE_MAX_PER_DAY). At the verdict the procedure row records the
 * lifecycle decision; nothing is promoted or delivered to a production maker.
 */
export const pl001On = (env: NodeJS.ProcessEnv = process.env): boolean => env.PL_001_MODE === 'on';
/** The share of the daily remote gym cap PL-001 may take while the start trial genomes are still in trial (0 = none). */
export function plCapShare(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PL_001_CAP_SHARE);
  return Number.isFinite(n) && n > 0 ? Math.min(1, n) : 0;
}
export const PL_ID = 'pl-001';
/** loop_runs.loop_name of a PL-001 attempt — never 'evolution-gym' (the TG-001 provenance pattern, #778) */
export const PL_LOOP = 'pl-001';
export const PL_PROTOCOL = 'docs/research/procedure-loop/PL-001_PROTOCOL.md';
export const PL_PREREG_SHA256 = 'fa136ae5946574f749bce23a190acc7632e5a6135f4d4577e311e9ea0dfb616c';
/** The protocol's treatment digest; any other digest is a different treatment and not PL-001. */
export const PL_LINES_SHA256 = '6dddbba133cdca3774927f6c634e256a2b1d53d65b127dd3b2637511be95f068';
/** sha256('') — the digest of the empty line list arm A is sent */
export const PL_NO_LINES_SHA256 = linesSha256([]);
export const PL_ARMS = ['A', 'B'] as const;
export type PlArm = typeof PL_ARMS[number];
export const PL_ARM_NAMES: Record<PlArm, string> = { A: 'baseline (gym goal, no lines)', B: 'candidate (gym goal + procedure lines)' };
export const PL_SPECIES = 'atomic@llama-router';
export const PL_TASKS = 75;
export const PL_PAIRS = 60;
export const PL_ALPHA = 0.05;
export const PL_MAX_DAYS = 14;
export const PL_MAX_RETRIES = 2;
export const PL_HARM_E = 20;
export const PL_HARM_SCOPE_MARGIN = 3;
export const PL_MUTANT_TIERS = [3, 4, 5, 6] as const;
export const PL_STEP_BUDGET = 40;
/** The trial genomes the protocol's start condition waits on. */
export const PL_START_GENOMES = ['g-a187f81f', 'g-d14c1156'] as const;
/** A worker that reports the delivered lines digest in its fire check (scripts/gym-worker.mjs fireCheck lines_sha256). */
export const PL_CAPABILITY = 'procedure_lines';
export const PL_REQUIRED_CAPABILITIES = ['prod_gates', PL_CAPABILITY] as const;
export const PL_FLAGS = ['PL_001_MODE', 'PL_001_CAP_SHARE', 'GYM_PROD_GATES', 'GYM_MAKER_TIMEOUT_MS', 'EVOLUTION_GYM_REMOTE_MAX_PER_DAY', 'HACK_DETECTOR_MODE', 'GRADED_FITNESS_MODE'];
export type PlVerdict = 'SUPPORTED' | 'NOT_SUPPORTED' | 'INCONCLUSIVE' | 'STOPPED_FOR_HARM';

const sha = (t: string): string => createHash('sha256').update(t).digest('hex');
const DAY = 86_400_000;
/** The arm a task runs first, fixed at freeze time: A when the first byte of sha256('pl-001:' + key) is even. */
export const orderSha = (key: string): string => sha(`pl-001:${key}`);
export const firstArm = (key: string): PlArm => (parseInt(orderSha(key).slice(0, 2), 16) % 2 === 0 ? 'A' : 'B');

/**
 * The gym goal the worker sends for a repair task (scripts/gym-worker.mjs gymGoal(task, false, lines) + the trailing newline
 * makerInput adds), mirrored so the server can name the exact goal sha256 each arm must report (pl-001.test.ts compares them).
 */
export function plGoal(task: { tests: string[]; source: string }, lines: readonly string[]): string {
  const strategy = lines.length ? `\n\nStrategy:\n${lines.map((l) => `- ${String(l).slice(0, 300)}`).join('\n')}` : '';
  return `${oneLine(`Evolution gym: make ${task.tests.join(', ')} pass. Change only ${task.source}. The tests describe the intended behaviour; do not edit them.${strategy}`)}\n`;
}

/**
 * Pre-start selector check (protocol): a seeded set of unfit tasks that must all get does_not_apply under the contract —
 * one `applies` stops the start. `expect` is the clause that must fail first.
 */
export const PL_UNFIT: ReadonlyArray<{ name: string; task: GymTask & { kind?: string; lane?: string }; capabilities: string[]; expect: ClauseName }> = [
  { name: 'write_test task', task: { commit: 'unfit:1', kind: 'write_test', source: 'packages/server/src/__tests__/a.test.ts', tests: ['packages/server/src/__tests__/a.test.ts'], sourceLines: 1 }, capabilities: ['prod_gates'], expect: 'task_kind' },
  { name: 'unknown kind', task: { commit: 'unfit:2', kind: 'refactor', source: 'packages/server/src/services/a.ts', tests: [], sourceLines: 1 }, capabilities: ['prod_gates'], expect: 'task_kind' },
  { name: 'other lane', task: { commit: 'unfit:3', lane: 'docs', source: 'packages/server/src/services/a.ts', tests: [], sourceLines: 1 }, capabilities: ['prod_gates'], expect: 'lane' },
  { name: 'test file', task: { commit: 'unfit:4', source: 'packages/server/src/__tests__/a.test.ts', tests: [], sourceLines: 1 }, capabilities: ['prod_gates'], expect: 'exclusions' },
  { name: 'test file under services', task: { commit: 'unfit:5', source: 'packages/server/src/services/a.test.ts', tests: [], sourceLines: 1 }, capabilities: ['prod_gates'], expect: 'exclusions' },
  { name: '__tests__ under services', task: { commit: 'unfit:6', source: 'packages/server/src/services/__tests__/a.ts', tests: [], sourceLines: 1 }, capabilities: ['prod_gates'], expect: 'exclusions' },
  { name: 'declaration file', task: { commit: 'unfit:7', source: 'packages/server/src/services/a.d.ts', tests: [], sourceLines: 1 }, capabilities: ['prod_gates'], expect: 'exclusions' },
  { name: 'generated file', task: { commit: 'unfit:8', source: 'packages/server/src/services/a.generated.ts', tests: [], sourceLines: 1 }, capabilities: ['prod_gates'], expect: 'exclusions' },
  { name: 'JS file', task: { commit: 'unfit:9', source: 'packages/server/src/services/a.js', tests: [], sourceLines: 1 }, capabilities: ['prod_gates'], expect: 'file_patterns' },
  { name: 'route file', task: { commit: 'unfit:10', source: 'packages/server/src/routes/a.ts', tests: [], sourceLines: 1 }, capabilities: ['prod_gates'], expect: 'file_patterns' },
  { name: 'dashboard file', task: { commit: 'unfit:11', source: 'packages/dashboard/src/a.ts', tests: [], sourceLines: 1 }, capabilities: ['prod_gates'], expect: 'file_patterns' },
  { name: 'worker without prod_gates', task: { commit: 'unfit:12', source: 'packages/server/src/services/a.ts', tests: [], sourceLines: 1 }, capabilities: [], expect: 'required_capabilities' },
];
export function plSelectorCheck(contract: ApplicabilityContract) {
  const results = PL_UNFIT.map((u) => { const s = selectProcedure(contract, taskFeatures(u.task, u.capabilities)); return { name: u.name, decision: s.decision, failed_clause: s.failed_clause, expected_clause: u.expect }; });
  const applies = results.filter((r) => r.decision === 'applies').map((r) => r.name);
  return { n: results.length, does_not_apply: results.length - applies.length, applies, ok: applies.length === 0 && results.length >= 10, results };
}

export interface PlTask {
  key: string; kind: 'mutant' | 'mined'; base: string | null; source: string; tests: string[]; tier: number | null;
  mutant_sha256: string | null; order_sha256: string; first_arm: PlArm;
  /** the task as it is served (a mutant task carries its mutated file) */
  task: GymTask;
}
export interface PlManifest {
  id: string; protocol: string; prereg_sha256: string; frozen_at: string; commit: string | null; harness: string | null; species: string; step_budget: number;
  flags: Record<string, string | null>; evaluator: { prod_gates: unknown };
  procedure: { id: string; version: number; lines: string[]; lines_sha256: string; contract: ApplicabilityContract };
  selector_check: ReturnType<typeof plSelectorCheck>;
  tasks: PlTask[];
  pool: { candidates: number; eligible: number; excluded: Record<string, number> };
  analysis: {
    hypothesis: string; primary: string; test: string; alpha: number; n_pairs: number; max_days: number; order_rule: string;
    retry_policy: string; harm_rules: string[]; verdicts: Record<PlVerdict, string>; lifecycle: Record<PlVerdict, string>;
    condition_order: Array<{ seq: number; task_key: string; arm: PlArm }>;
  };
}

export function plManifest(db: Database): PlManifest | null {
  try { const row = db.prepare('SELECT manifest_json FROM pl_experiments WHERE id = ?').get(PL_ID) as { manifest_json: string } | undefined; return row ? JSON.parse(row.manifest_json) as PlManifest : null; } catch { return null; }
}
export const plManifestSha = (m: PlManifest): string => sha(canonicalJson(m));

/** Every key PL-001 froze (never served as ordinary gym work, never frozen into a holdout). */
export function plTaskKeys(db: Database): Set<string> {
  try { return new Set((db.prepare('SELECT DISTINCT task_key AS k FROM pl_attempts').all() as Array<{ k: string }>).map((r) => r.k)); } catch { return new Set(); }
}

/**
 * Freeze once (the operator's PL_001_MODE=on): the procedure row must carry the protocol digest, the unfit selector set must
 * all be does_not_apply, and PL_TASKS applicable tasks must survive the exclusions — never a holdout key of any table or
 * epoch, a TG-001 key, a trial-attempted or dream-exposed key (holdoutExclusions), or a key with an earlier evolution-gym
 * attempt. The eligible tasks are ordered by sha256('pl-001:' + key) and the first PL_TASKS frozen; anything short of that
 * freezes nothing.
 */
export function freezePl001(db: Database, candidates: GymTask[], ctx: { species: string; commit: string | null; harness: string | null; prodGates: unknown; now: string },
  env: NodeJS.ProcessEnv = process.env): { frozen: boolean; reason?: string; manifest?: PlManifest } {
  const existing = plManifest(db);
  if (existing) return { frozen: true, manifest: existing };
  ensureProcedures(db, ctx.now);
  const p: Procedure | null = procedure(db, PROCEDURE_ID);
  if (!p) return { frozen: false, reason: `procedure ${PROCEDURE_ID} missing or unreadable` };
  if (p.lines_sha256 !== PL_LINES_SHA256) return { frozen: false, reason: `procedure lines digest ${p.lines_sha256.slice(0, 12)}… is not the protocol's ${PL_LINES_SHA256.slice(0, 12)}…` };
  const check = plSelectorCheck(p.contract);
  if (!check.ok) return { frozen: false, reason: `pre-start selector check failed: ${check.applies.join(', ') || `only ${check.n} unfit tasks`}` };
  const ex = holdoutExclusions(db);
  let prior = new Set<string>();
  try { prior = new Set((db.prepare("SELECT DISTINCT json_extract(metadata, '$.gym.commit') AS k FROM loop_runs WHERE loop_name = 'evolution-gym'").all() as Array<{ k: string | null }>).map((r) => r.k).filter((k): k is string => Boolean(k))); } catch { /* none */ }
  const excluded: Record<string, number> = {}; const bump = (r: string) => { excluded[r] = (excluded[r] ?? 0) + 1; };
  const seen = new Set<string>(); const eligible: GymTask[] = [];
  for (const t of candidates) {
    if (!t?.commit || seen.has(t.commit)) continue;
    seen.add(t.commit);
    const why = exclusionReason(ex, t as GymTask & { base?: string })
      ?? (prior.has(t.commit) ? 'earlier evolution-gym attempt' : null)
      ?? (() => { const s = selectProcedure(p.contract, taskFeatures(t, ['prod_gates'])); return s.decision === 'applies' ? null : `does_not_apply (${s.failed_clause})`; })();
    if (why) { bump(why.replace(/ (file|commit|run) .+$/, ' $1')); continue; }
    eligible.push(t);
  }
  if (eligible.length < PL_TASKS) return { frozen: false, reason: `only ${eligible.length} applicable, unexposed tasks (need ${PL_TASKS})` };
  const chosen = eligible.map((t) => ({ t, o: orderSha(t.commit) })).sort((a, b) => (a.o < b.o ? -1 : a.o > b.o ? 1 : 0)).slice(0, PL_TASKS);
  const tasks: PlTask[] = chosen.map(({ t, o }) => {
    const m = t as GymTask & { base?: string; mutant?: string; tier?: number };
    return { key: t.commit, kind: typeof m.mutant === 'string' ? 'mutant' : 'mined', base: m.base ?? null, source: t.source, tests: [...t.tests], tier: typeof m.tier === 'number' ? m.tier : null,
      mutant_sha256: typeof m.mutant === 'string' ? sha(m.mutant) : null, order_sha256: o, first_arm: firstArm(t.commit), task: t };
  });
  const condition_order = tasks.flatMap((t, i) => { const f = t.first_arm; const s: PlArm = f === 'A' ? 'B' : 'A'; return [{ seq: 2 * i, task_key: t.key, arm: f }, { seq: 2 * i + 1, task_key: t.key, arm: s }]; });
  const manifest: PlManifest = {
    id: PL_ID, protocol: PL_PROTOCOL, prereg_sha256: PL_PREREG_SHA256, frozen_at: ctx.now, commit: ctx.commit, harness: ctx.harness, species: ctx.species, step_budget: PL_STEP_BUDGET,
    flags: Object.fromEntries(PL_FLAGS.map((f) => [f, env[f] ?? null])), evaluator: { prod_gates: ctx.prodGates },
    procedure: { id: p.id, version: p.version, lines: [...p.lines], lines_sha256: p.lines_sha256, contract: p.contract }, selector_check: check, tasks,
    pool: { candidates: seen.size, eligible: eligible.length, excluded },
    analysis: {
      hypothesis: 'H-PL1: adding the procedure lines to the gym goal raises the share of tasks with a gated verified success (atomic@llama-router, applicable repair tasks)',
      primary: 'share of assigned tasks with a gated verified success per arm, paired by task; intention to treat (a censored arm is not verified)',
      test: 'exact one-sided McNemar p = P(X >= b), X ~ Bin(b + c, 1/2); b = B verified and A not, c = A verified and B not; supported iff b > c and p < alpha',
      alpha: PL_ALPHA, n_pairs: PL_PAIRS, max_days: PL_MAX_DAYS, order_rule: "A first when the first byte of sha256('pl-001:' + task_key) is even, else B first",
      retry_policy: `an infra discard or a VOID attempt re-serves the arm at most ${PL_MAX_RETRIES}x (3 physical attempts); then INFRA_CENSORED; every physical attempt is kept`,
      harm_rules: [`e-value for baseline beats candidate (ePaired, baseline wins +1) >= ${PL_HARM_E}`, 'any canary solved since the first attempt', `arm B has >= ${PL_HARM_SCOPE_MARGIN} more out-of-scope or hack-flagged results than arm A`],
      verdicts: { SUPPORTED: `${PL_PAIRS} pairs, b > c and p < ${PL_ALPHA}`, NOT_SUPPORTED: `${PL_PAIRS} pairs, not significant`, INCONCLUSIVE: `day ${PL_MAX_DAYS} before ${PL_PAIRS} pairs`, STOPPED_FOR_HARM: 'a harm rule fired after a completed pair' },
      lifecycle: { SUPPORTED: "procedure status 'validated' (an operator decision is still needed before any production delivery)", NOT_SUPPORTED: "procedure status 'retired' + a negative-evidence draft", STOPPED_FOR_HARM: "procedure status 'retired' + a negative-evidence draft", INCONCLUSIVE: "procedure stays 'candidate' with the reason" },
      condition_order,
    },
  };
  const ins = db.prepare("INSERT INTO pl_attempts (id, experiment_id, task_key, arm, seq, status, retries, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)");
  db.transaction(() => {
    db.prepare('INSERT INTO pl_experiments (id, frozen_at, manifest_json, manifest_sha256) VALUES (?, ?, ?, ?)').run(PL_ID, ctx.now, JSON.stringify(manifest), plManifestSha(manifest));
    for (const s of condition_order) ins.run(`${PL_ID}:${randomUUID()}`, PL_ID, s.task_key, s.arm, s.seq, ctx.now);
  })();
  return { frozen: true, manifest };
}

/** A refused freeze is recorded (the caller retries at most hourly) so the evidence can say why nothing is frozen. */
export function recordPlFreezeRefusal(db: Database, reason: string, now: string): void {
  try {
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, model, created_at)
      VALUES (?, 'pl_001_freeze', 'experiment', ?, ?, 'on', 'refused', ?, '{}', 'policy', ?)`).run(randomUUID(), PL_ID, sha(reason).slice(0, 16), reason.slice(0, 300), now);
  } catch { /* bookkeeping */ }
}
export function lastPlFreezeRefusal(db: Database): { reason: string; at: string } | null {
  try { const r = db.prepare("SELECT reason, created_at AS at FROM judgments WHERE judgment = 'pl_001_freeze' ORDER BY created_at DESC LIMIT 1").get() as { reason: string; at: string } | undefined; return r ?? null; } catch { return null; }
}

/** The analysis may only run on the manifest frozen before the data: its stored sha256 must match and it must predate the first attempt. */
export function plManifestValidity(db: Database, m: PlManifest): { valid: boolean; reason: string | null } {
  let row: { frozen_at: string; manifest_sha256: string | null } | undefined;
  try { row = db.prepare('SELECT frozen_at, manifest_sha256 FROM pl_experiments WHERE id = ?').get(m.id) as typeof row; } catch { return { valid: false, reason: 'manifest fingerprint unreadable' }; }
  if (!row?.manifest_sha256) return { valid: false, reason: 'no stored manifest fingerprint' };
  if (plManifestSha(m) !== row.manifest_sha256) return { valid: false, reason: 'manifest changed after freeze' };
  if (m.procedure.lines_sha256 !== PL_LINES_SHA256 || linesSha256(m.procedure.lines) !== PL_LINES_SHA256) return { valid: false, reason: 'manifest lines are not the protocol treatment' };
  const first = plFirstAttempt(db);
  if (first === undefined) return { valid: false, reason: 'attempt history unreadable' };
  if (first && m.frozen_at >= first) return { valid: false, reason: `manifest (${m.frozen_at}) not frozen before the first physical attempt (${first})` };
  return { valid: true, reason: null };
}

/** Earliest physical attempt (a claim); null = none yet; undefined = unreadable. */
export function plFirstAttempt(db: Database): string | null | undefined {
  try { return (db.prepare('SELECT MIN(first_claimed_at) AS t FROM pl_attempts WHERE experiment_id = ?').get(PL_ID) as { t: string | null }).t ?? null; } catch { return undefined; }
}

/** Start condition (protocol): both trial genomes settled (no longer 'trial'), or an operator cap share. Trials keep priority. */
export function plStartCondition(db: Database, env: NodeJS.ProcessEnv = process.env) {
  const status = (id: string): string | null => { try { return (db.prepare('SELECT status FROM maker_genomes WHERE id = ?').get(id) as { status: string } | undefined)?.status ?? null; } catch { return null; } };
  const genomes = PL_START_GENOMES.map((id) => ({ id, status: status(id) }));
  const settled = genomes.every((g) => g.status !== 'trial');
  const cap_share = plCapShare(env);
  return { genomes, settled, cap_share, open: settled || cap_share > 0, rule: settled ? 'settled' as const : cap_share > 0 ? 'cap_share' as const : 'waiting' as const };
}
/** PL-001 claims in the last 24 h (they count toward the remote gym cap like every remote gym run). */
export function plClaims24h(db: Database, now: number): number {
  try { return (db.prepare('SELECT COUNT(*) AS n FROM loop_runs WHERE loop_name = ? AND created_at >= ?').get(PL_LOOP, new Date(now - DAY).toISOString()) as { n: number }).n; } catch { return 0; }
}

/** The next pending (task, arm), lowest seq first, marked claimed for this run; null when stopped or nothing is pending. */
export function claimPl001(db: Database, m: PlManifest, runId: string, now: string): { attempt_id: string; arm: PlArm; task: GymTask; lines: string[] } | null {
  if (m.id !== PL_ID || !plManifestValidity(db, m).valid) return null;
  if (plState(db, m, Date.parse(now)).stop.stopped) return null;
  const row = db.prepare("SELECT id, task_key, arm FROM pl_attempts WHERE experiment_id = ? AND status = 'pending' ORDER BY seq LIMIT 1").get(PL_ID) as { id: string; task_key: string; arm: PlArm } | undefined;
  if (!row) return null;
  const entry = m.tasks.find((t) => t.key === row.task_key);
  if (!entry) return null;
  db.prepare("UPDATE pl_attempts SET status = 'claimed', run_id = ?, updated_at = ?, first_claimed_at = COALESCE(first_claimed_at, ?) WHERE id = ?").run(runId, now, now, row.id);
  return { attempt_id: row.id, arm: row.arm, task: entry.task, lines: row.arm === 'B' ? [...m.procedure.lines] : [] };
}

/** What the claim records on the run (gym.pl): the delivered lines digest and the goal sha256 the worker must report. */
export function plClaimMeta(attempt: { attempt_id: string; arm: PlArm; task: GymTask; lines: string[] }) {
  return { experiment: PL_ID, arm: attempt.arm, attempt_id: attempt.attempt_id, delivered_lines: attempt.lines.length,
    delivered_lines_sha256: linesSha256(attempt.lines), expected_goal_sha256: sha(plGoal(attempt.task, attempt.lines)) };
}
export type PlClaimMeta = ReturnType<typeof plClaimMeta>;

/**
 * Why a scored PL-001 attempt is VOID (null = it counts). The fire check is mandatory in both arms (whatever GENOME_FIRE_CHECK
 * says): arm B must have been sent exactly the protocol lines (delivered digest, the worker's received digest, 5 of 5 lines in
 * the prompt, and the goal sha256 of the gym goal with those lines); arm A must show 0 lines and the plain gym goal. A gated
 * success without its per-check gate map never proved its gates ran (ELIGIBLE_GATED) and is VOID too.
 */
export function plVoid(pl: PlClaimMeta, gated: boolean, status: string, prodGates: Record<string, string> | undefined, raw: unknown): string | null {
  if (status !== 'success' && status !== 'failure' && status !== 'quarantined') return null;
  if (!gated) return 'oracle: claimed without the production gates';
  if (status === 'success' && !prodGates) return 'oracle: gated success without per-check prod gate results (ELIGIBLE_GATED)';
  const f = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  const goal = typeof f?.goal_sha256 === 'string' && /^[0-9a-f]{64}$/.test(f.goal_sha256) ? f.goal_sha256 : null;
  if (!f || !goal) return 'fire_check: no evidence of the maker prompt';
  const lines = Number(f.genome_lines); const found = Number(f.genome_lines_found);
  const received = typeof f.lines_sha256 === 'string' ? f.lines_sha256 : null;
  if (pl.arm === 'B') {
    if (pl.delivered_lines_sha256 !== PL_LINES_SHA256) return `procedure: delivered lines digest ${pl.delivered_lines_sha256.slice(0, 12)}… is not the protocol's`;
    if (received !== PL_LINES_SHA256) return received ? `procedure: worker received lines digest ${received.slice(0, 12)}… is not the protocol's` : 'procedure: the worker did not report the received lines digest';
    if (lines !== 5 || found !== 5) return `fire_check: ${Number.isFinite(found) ? found : 'unknown'} of 5 procedure lines in the maker prompt`;
  } else {
    if (received !== PL_NO_LINES_SHA256) return received ? 'procedure: arm A received lines' : 'procedure: the worker did not report the received lines digest';
    if (lines !== 0 || found !== 0) return `fire_check: arm A prompt carries ${Number.isFinite(found) ? found : 'unknown'} procedure lines`;
  }
  if (goal !== pl.expected_goal_sha256) return 'fire_check: the goal sent differs from the protocol goal for this arm';
  return null;
}

export interface PlResult {
  run_id: string; status: string; reason: string; void: string | null; verified: boolean; out_of_scope: boolean; hack_flags: string[];
  graded: number | null; graded_kind: string | null; tokens: number | null; duration_ms: number | null; metrics: TgMetrics;
  fire_check: { goal_sha256: string | null; genome_lines: number | null; genome_lines_found: number | null; lines_sha256: string | null } | null; at: string;
}
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
export function plResult(input: { runId: string; status: string; reason: string; void: string | null; prodGates: Record<string, string> | undefined; hackFlags?: string[];
  graded?: number | null; gradedKind?: string | null; tokens: number | null; durationMs?: unknown; tgMetrics?: unknown; fireCheck?: unknown; now: string }): PlResult {
  const f = input.fireCheck && typeof input.fireCheck === 'object' ? input.fireCheck as Record<string, unknown> : null;
  return { run_id: input.runId, status: input.status, reason: input.reason.slice(0, 200), void: input.void,
    verified: input.status === 'success' && !input.void && Boolean(input.prodGates), out_of_scope: /^out of scope/.test(input.reason), hack_flags: input.hackFlags ?? [],
    graded: typeof input.graded === 'number' ? input.graded : null, graded_kind: input.gradedKind ?? null, tokens: input.tokens, duration_ms: num(input.durationMs),
    metrics: sanitizeTgMetrics(input.tgMetrics),
    fire_check: f ? { goal_sha256: typeof f.goal_sha256 === 'string' ? f.goal_sha256.slice(0, 64) : null, genome_lines: num(f.genome_lines), genome_lines_found: num(f.genome_lines_found),
      lines_sha256: typeof f.lines_sha256 === 'string' ? f.lines_sha256.slice(0, 64) : null } : null, at: input.now };
}

/**
 * A run's result settles its attempt. An infra discard or a VOID attempt re-serves the arm at most PL_MAX_RETRIES times, then
 * the arm is INFRA_CENSORED ('censored'). A task discard ('task:', e.g. the mutant survives) makes the task INVALID for both
 * arms (the other arm is not served). Anything else is the observation ('done'). Every physical attempt stays in history_json.
 */
export function recordPl001(db: Database, attemptId: string, r: PlResult): void {
  const row = db.prepare('SELECT task_key, status, retries, history_json FROM pl_attempts WHERE id = ? AND run_id = ? AND experiment_id = ?').get(attemptId, r.run_id, PL_ID) as
    { task_key: string; status: string; retries: number; history_json: string | null } | undefined;
  if (!row || row.status !== 'claimed') return;
  const history = [...(row.history_json ? JSON.parse(row.history_json) as unknown[] : []), r];
  const retry = (r.status === 'discarded' && /^infra:/.test(r.reason)) || r.void !== null;
  const status = retry ? (row.retries < PL_MAX_RETRIES ? 'pending' : 'censored') : r.status === 'discarded' ? 'invalid' : 'done';
  db.prepare("UPDATE pl_attempts SET status = ?, retries = ?, result_json = ?, history_json = ?, run_id = CASE WHEN ? = 'pending' THEN NULL ELSE run_id END, updated_at = ? WHERE id = ?")
    .run(status, retry && row.retries < PL_MAX_RETRIES ? row.retries + 1 : row.retries, JSON.stringify(r), JSON.stringify(history), status, r.at, attemptId);
  if (status === 'invalid') {
    db.prepare("UPDATE pl_attempts SET status = 'invalid', result_json = ?, updated_at = ? WHERE experiment_id = ? AND task_key = ? AND id <> ? AND status = 'pending'")
      .run(JSON.stringify({ status: 'discarded', reason: `task invalid: ${r.reason}`.slice(0, 200), at: r.at }), r.at, PL_ID, row.task_key, attemptId);
  }
}

export type PlObservation = 'verified' | 'not_verified' | 'INFRA_CENSORED' | 'INVALID' | 'pending';
interface Row { task_key: string; arm: PlArm; seq: number; status: string; retries: number; run_id: string | null; result: PlResult | null; history: PlResult[]; updated_at: string }
function rows(db: Database): Row[] {
  try {
    return (db.prepare('SELECT task_key, arm, seq, status, retries, run_id, result_json, history_json, updated_at FROM pl_attempts WHERE experiment_id = ? ORDER BY seq').all(PL_ID) as
      Array<{ task_key: string; arm: PlArm; seq: number; status: string; retries: number; run_id: string | null; result_json: string | null; history_json: string | null; updated_at: string }>)
      .map((r) => ({ ...r, result: r.result_json ? JSON.parse(r.result_json) as PlResult : null, history: r.history_json ? JSON.parse(r.history_json) as PlResult[] : [] }));
  } catch { return []; }
}
export function plObservation(r: { status: string; result: { verified?: boolean } | null }): PlObservation {
  if (r.status === 'censored') return 'INFRA_CENSORED';
  if (r.status === 'invalid') return 'INVALID';
  if (r.status === 'done') return r.result?.verified ? 'verified' : 'not_verified';
  return 'pending';
}

export interface PlPair { task_key: string; A: PlObservation; B: PlObservation; completed_at: string; a: Row; b: Row }
/** The paired analysis on completed pairs (ITT: a censored arm is not verified); sensitivity drops pairs with a censored arm. */
export function plPaired(pairs: Array<Pick<PlPair, 'A' | 'B'>>) {
  const v = (o: PlObservation) => o === 'verified';
  let both = 0; let b = 0; let c = 0; let neither = 0;
  for (const p of pairs) { if (v(p.A) && v(p.B)) both++; else if (v(p.B)) b++; else if (v(p.A)) c++; else neither++; }
  const n = pairs.length;
  const p = n ? mcnemarOneSided(b, c) : null;
  return { n_pairs: n, both_verified: both, b_only_B: b, c_only_A: c, neither, verified_A: n ? both + c : null, verified_B: n ? both + b : null,
    rate_A: n ? (both + c) / n : null, rate_B: n ? (both + b) / n : null, p_one_sided: p, supported: n ? b > c && (p as number) < PL_ALPHA : null };
}
const median = (xs: number[]): number | null => { if (!xs.length) return null; const s = [...xs].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);
const r3 = (v: number | null): number | null => (v === null ? null : Math.round(v * 1000) / 1000);

/** The whole experiment state: pairs, analysis, harm, stop rule and the verdict (null while collecting). */
export function plState(db: Database, m: PlManifest, now = Date.now()) {
  const frozen = new Set(m.tasks.map((t) => t.key));
  const all = rows(db).filter((r) => frozen.has(r.task_key)); // only the manifest's tasks are ever observations
  const byTask = new Map<string, Partial<Record<PlArm, Row>>>();
  for (const r of all) { const t = byTask.get(r.task_key) ?? {}; t[r.arm] = r; byTask.set(r.task_key, t); }
  const final = (o: PlObservation) => o === 'verified' || o === 'not_verified' || o === 'INFRA_CENSORED';
  const completed: PlPair[] = [];
  let invalid = 0;
  for (const [task_key, t] of byTask) {
    if (!t.A || !t.B) continue;
    const A = plObservation(t.A); const B = plObservation(t.B);
    if (A === 'INVALID' || B === 'INVALID') { invalid++; continue; }
    if (final(A) && final(B)) completed.push({ task_key, A, B, completed_at: t.A.updated_at > t.B.updated_at ? t.A.updated_at : t.B.updated_at, a: t.A, b: t.B });
  }
  completed.sort((x, y) => (x.completed_at < y.completed_at ? -1 : x.completed_at > y.completed_at ? 1 : x.a.seq - y.a.seq));
  const analysed = completed.slice(0, PL_PAIRS);
  const primary = plPaired(analysed);
  const sensitivity = plPaired(analysed.filter((p) => p.A !== 'INFRA_CENSORED' && p.B !== 'INFRA_CENSORED'));
  // harm, checked over the completed pairs: e-value for baseline beats candidate on the discordant pairs (baseline win = +1)
  const discordant: Array<1 | -1> = []; for (const p of analysed) { if (p.A === 'verified' && p.B !== 'verified') discordant.push(1); else if (p.B === 'verified' && p.A !== 'verified') discordant.push(-1); }
  const e = ePaired(discordant);
  const first = plFirstAttempt(db) ?? null;
  let canary = 0;
  if (first) { try { canary = (db.prepare("SELECT COUNT(*) AS n FROM loop_runs WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym.canary') = 1 AND json_extract(metadata, '$.gym_result.status') = 'success' AND created_at >= ?").get(first) as { n: number }).n; } catch { /* unknown: 0 solved is not claimed below */ } }
  const flagged = (arm: PlArm) => all.filter((r) => r.arm === arm && r.status === 'done' && r.result && (r.result.out_of_scope || r.result.hack_flags.length > 0)).length;
  const scopeHack = { A: flagged('A'), B: flagged('B') };
  const harmReason = e >= PL_HARM_E ? `e-value ${e.toFixed(2)} >= ${PL_HARM_E} for baseline beats candidate` : canary > 0 ? `${canary} canary solved since the first attempt`
    : scopeHack.B - scopeHack.A >= PL_HARM_SCOPE_MARGIN ? `arm B has ${scopeHack.B - scopeHack.A} more out-of-scope or hack-flagged results than arm A` : null;
  const dayLimit = first ? new Date(Date.parse(first) + PL_MAX_DAYS * DAY).toISOString() : null;
  const pastDay = dayLimit !== null && now >= Date.parse(dayLimit);
  const verdict: PlVerdict | null = harmReason ? 'STOPPED_FOR_HARM' : completed.length >= PL_PAIRS ? (primary.supported ? 'SUPPORTED' : 'NOT_SUPPORTED') : pastDay ? 'INCONCLUSIVE' : null;
  const stopReason = harmReason ?? (completed.length >= PL_PAIRS ? `${PL_PAIRS} completed pairs` : pastDay ? `day ${PL_MAX_DAYS} (${dayLimit}) before ${PL_PAIRS} pairs` : null);
  return { rows: all, completed, analysed, invalid, primary, sensitivity,
    harm: { e_value: discordant.length ? r3(e) : null, threshold: PL_HARM_E, canary_solved: first ? canary : null, scope_hack: scopeHack, margin: PL_HARM_SCOPE_MARGIN, triggered: Boolean(harmReason), reason: harmReason },
    stop: { first_attempt_at: first, day_limit_at: dayLimit, stopped: verdict !== null, reason: stopReason }, verdict };
}

/**
 * Lifecycle decision at the verdict, recorded on the procedure row (never a promotion): SUPPORTED → 'validated' (an operator
 * decision is still needed before any production delivery); NOT_SUPPORTED / STOPPED_FOR_HARM → 'retired' + a negative-evidence
 * draft (a `negative_evidence_draft` judgment; the registry file is the operator's to edit); INCONCLUSIVE → stays 'candidate'
 * with the reason. Only from 'candidate', once. Never 'trial' or 'active'; GENOME_APPLY_MODE and production prompts untouched.
 */
export function applyPl001Lifecycle(db: Database, m: PlManifest, state: ReturnType<typeof plState>, now: string): { applied: boolean; status?: string } {
  if (!state.verdict) return { applied: false };
  const row = db.prepare("SELECT status, evidence_sources_json AS s FROM maker_genomes WHERE id = ? AND gene = 'procedure'").get(m.procedure.id) as { status: string; s: string | null } | undefined;
  if (!row || row.status !== 'candidate') return { applied: false };
  try { if ((JSON.parse(row.s ?? '{}') as { procedure?: { lifecycle?: unknown } }).procedure?.lifecycle) return { applied: false }; } catch { return { applied: false }; }
  const v = state.verdict; const p = state.primary;
  const status = v === 'SUPPORTED' ? 'validated' : v === 'INCONCLUSIVE' ? 'candidate' : 'retired';
  const summary = `PL-001 ${v}: ${p.n_pairs} pairs, b ${p.b_only_B} vs c ${p.c_only_A}, one-sided McNemar p ${p.p_one_sided === null ? 'not computed' : p.p_one_sided.toPrecision(3)}; ${state.stop.reason ?? ''}`.trim();
  const lifecycle = { experiment: PL_ID, verdict: v, decided_at: now, status, reason: summary, manifest_sha256: plManifestSha(m), pairs: p.n_pairs, b: p.b_only_B, c: p.c_only_A, p_one_sided: p.p_one_sided,
    promoted: false, production_delivery: 'not delivered; any delivery is a separate operator decision', ...(status === 'retired' ? { negative_evidence: 'draft recorded (judgment negative_evidence_draft); the operator adds it to NEGATIVE_EVIDENCE.yaml' } : {}) };
  const note = v === 'SUPPORTED' ? `${summary} — validated, not promoted: an operator decision is needed before any production delivery` : v === 'INCONCLUSIVE' ? `${summary} — stays candidate` : `${summary} — retired`;
  db.transaction(() => {
    // literal statuses only (promotion-path-integrity: a parameterised status could be 'active'; this path never writes it)
    const sql = {
      validated: "UPDATE maker_genomes SET status = 'validated', note = ?, updated_at = ?, evidence_sources_json = json_set(COALESCE(evidence_sources_json, '{}'), '$.procedure.lifecycle', json(?)) WHERE id = ? AND status = 'candidate'",
      retired: "UPDATE maker_genomes SET status = 'retired', note = ?, updated_at = ?, evidence_sources_json = json_set(COALESCE(evidence_sources_json, '{}'), '$.procedure.lifecycle', json(?)) WHERE id = ? AND status = 'candidate'",
      candidate: "UPDATE maker_genomes SET status = 'candidate', note = ?, updated_at = ?, evidence_sources_json = json_set(COALESCE(evidence_sources_json, '{}'), '$.procedure.lifecycle', json(?)) WHERE id = ? AND status = 'candidate'",
    }[status];
    db.prepare(sql).run(note.slice(0, 500), now, JSON.stringify(lifecycle), m.procedure.id);
    if (status === 'retired') {
      const draft = { id: 'NE-PL-001 (draft)', title: `Procedure ${m.procedure.id} for gym repair makers`, hypothesis: m.analysis.hypothesis, verdict: 'REJECT', decided_on: now.slice(0, 10),
        conditions: `${m.species}, ${m.tasks.length} frozen applicable repair tasks, manifest sha256 ${plManifestSha(m)}`, result: summary,
        evidence: [PL_PROTOCOL, `PREREG_SHA256 ${PL_PREREG_SHA256}`, `lines_sha256 ${PL_LINES_SHA256}`],
        reopen_condition: 'A new pre-registered comparison with a different procedure version or task population reaches its own verdict.' };
      db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, model, created_at)
        VALUES (?, 'negative_evidence_draft', 'procedure', ?, ?, 'on', 'draft', ?, ?, 'policy', ?)`).run(randomUUID(), m.procedure.id, sha(JSON.stringify(draft)).slice(0, 16), summary.slice(0, 300), JSON.stringify(draft), now);
    }
  })();
  return { applied: true, status };
}

/** Evidence `pl_001`: the frozen set, pairs done / target, per-arm outcomes, the analysis, harm, stop, verdict, lifecycle and the runs. */
export function pl001Evidence(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  let p: Procedure | null = null; let rowStatus: string | null = null; let lifecycle: unknown = null;
  try {
    p = procedure(db, PROCEDURE_ID);
    const r = db.prepare("SELECT status, evidence_sources_json AS s FROM maker_genomes WHERE id = ? AND gene = 'procedure'").get(PROCEDURE_ID) as { status: string; s: string | null } | undefined;
    rowStatus = r?.status ?? null;
    lifecycle = r?.s ? (JSON.parse(r.s) as { procedure?: { lifecycle?: unknown } }).procedure?.lifecycle ?? null : null;
  } catch { /* table absent: null */ }
  const base = {
    mode: pl001On(env) ? 'on' as const : 'off' as const, experiment_id: PL_ID, protocol: PL_PROTOCOL, prereg_sha256: PL_PREREG_SHA256, loop_name: PL_LOOP,
    procedure: { id: PROCEDURE_ID, version: p?.version ?? null, lines_sha256: p?.lines_sha256 ?? null, protocol_lines_sha256: PL_LINES_SHA256,
      digest_matches: p ? p.lines_sha256 === PL_LINES_SHA256 : null, status: rowStatus, lifecycle },
    start_condition: plStartCondition(db, env), selector_check: p ? plSelectorCheck(p.contract) : null, targets: { pairs: PL_PAIRS, tasks: PL_TASKS, max_days: PL_MAX_DAYS, alpha: PL_ALPHA },
  };
  const m = plManifest(db);
  if (!m) return { ...base, status: 'not_frozen' as const, freeze_refused: lastPlFreezeRefusal(db), manifest: null, pairs: null, arms: [], primary: null, sensitivity: null, secondary: null, harm: null, stop: null, verdict: null, runs: [] };
  const validity = plManifestValidity(db, m);
  const manifest = { frozen_at: m.frozen_at, sha256: plManifestSha(m), tasks: m.tasks.length, species: m.species, step_budget: m.step_budget, commit: m.commit, harness: m.harness,
    by_kind: { mutant: m.tasks.filter((t) => t.kind === 'mutant').length, mined: m.tasks.filter((t) => t.kind === 'mined').length },
    by_tier: Object.fromEntries([...new Set(m.tasks.map((t) => t.tier))].filter((t): t is number => t !== null).sort().map((t) => [String(t), m.tasks.filter((x) => x.tier === t).length])),
    first_arm: { A: m.tasks.filter((t) => t.first_arm === 'A').length, B: m.tasks.filter((t) => t.first_arm === 'B').length }, pool: m.pool, valid: validity.valid, reason: validity.reason };
  if (!validity.valid) return { ...base, status: 'invalid_manifest' as const, freeze_refused: null, manifest, pairs: null, arms: [], primary: null, sensitivity: null, secondary: null, harm: null, stop: null, verdict: null, runs: [] };
  const s = plState(db, m, now);
  const arms = PL_ARMS.map((arm) => {
    const mine = s.rows.filter((r) => r.arm === arm);
    const obs = mine.map(plObservation);
    const physical = mine.flatMap((r) => r.history);
    const done = mine.filter((r) => r.status === 'done' && r.result);
    const tokensKnown = done.map((r) => r.result!.tokens).filter((t): t is number => typeof t === 'number' && t > 0);
    const graded = done.map((r) => r.result!.graded).filter((g): g is number => typeof g === 'number');
    const maker = done.map((r) => r.result!.metrics?.maker_ms).filter((x): x is number => typeof x === 'number');
    const infra = physical.filter((h) => h.status === 'discarded' && /^infra:/.test(h.reason)).length;
    return { arm, name: PL_ARM_NAMES[arm], observations: obs.filter((o) => o === 'verified' || o === 'not_verified').length,
      verified: obs.filter((o) => o === 'verified').length, not_verified: obs.filter((o) => o === 'not_verified').length, infra_censored: obs.filter((o) => o === 'INFRA_CENSORED').length,
      invalid: obs.filter((o) => o === 'INVALID').length, pending: obs.filter((o) => o === 'pending').length,
      physical_attempts: physical.length, infra_attempts: infra, void_attempts: physical.filter((h) => h.void).length,
      infra_rate: physical.length ? r3(infra / physical.length) : null,
      tokens: { known: tokensKnown.length, unknown: done.length - tokensKnown.length, mean_known: tokensKnown.length ? Math.round(mean(tokensKnown)!) : null },
      graded_mean: r3(mean(graded)), maker_ms_median: median(maker), out_of_scope_or_hack: s.harm.scope_hack[arm] };
  });
  // secondary (descriptive): paired graded difference and paired maker wall time, B − A, on pairs where both are known
  const gradedPairs = s.analysed.map((x) => [x.a.result?.graded, x.b.result?.graded]).filter((g): g is [number, number] => typeof g[0] === 'number' && typeof g[1] === 'number');
  const makerPairs = s.analysed.map((x) => [x.a.result?.metrics?.maker_ms, x.b.result?.metrics?.maker_ms]).filter((g): g is [number, number] => typeof g[0] === 'number' && typeof g[1] === 'number');
  const secondary = { graded_mean_diff_B_minus_A: r3(mean(gradedPairs.map(([a, b]) => b - a))), graded_pairs: gradedPairs.length,
    maker_ms_median_diff_B_minus_A: median(makerPairs.map(([a, b]) => b - a)), maker_ms_pairs: makerPairs.length,
    note: 'descriptive only: no multiplicity correction, no claims; tokens are known only when the maker printed a count (unknown kept separate, never 0)' };
  const runs = s.rows.flatMap((r) => r.history.map((h) => ({ task_key: r.task_key, arm: r.arm, run_id: h.run_id, status: h.status, reason: h.reason, void: h.void, verified: h.verified, at: h.at })))
    .concat(s.rows.filter((r) => r.status === 'claimed' && r.run_id).map((r) => ({ task_key: r.task_key, arm: r.arm, run_id: r.run_id as string, status: 'running', reason: '', void: null, verified: false, at: r.updated_at })))
    .sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0)).slice(0, 25);
  const open = s.rows.some((r) => r.status === 'pending' || r.status === 'claimed');
  const status = s.verdict ? 'stopped' as const : !s.stop.first_attempt_at && !base.start_condition.open ? 'waiting_start' as const : open ? 'collecting' as const : 'exhausted' as const;
  return { ...base, status, freeze_refused: null, manifest,
    pairs: { done: s.completed.length, analysed: s.analysed.length, target: PL_PAIRS, invalid_tasks: s.invalid, tasks: m.tasks.length },
    arms, primary: s.primary.n_pairs ? s.primary : null, sensitivity: s.sensitivity.n_pairs ? s.sensitivity : null, secondary, harm: s.harm, stop: s.stop, verdict: s.verdict, runs };
}

/** GO checklist (read-only): what must hold before the operator lets PL-001 attempts start. */
export function plGoChecklist(db: Database, deploy: { commit: string | null; worker_sha256: string | null }, env: NodeJS.ProcessEnv = process.env) {
  const m = plManifest(db);
  const validity = m ? plManifestValidity(db, m) : { valid: false, reason: 'not frozen' };
  const start = plStartCondition(db, env);
  const checks = {
    mode_on: pl001On(env), prod_gates_on: env.GYM_PROD_GATES === 'true', frozen: Boolean(m), manifest_valid: validity.valid,
    procedure_digest: Boolean(m && m.procedure.lines_sha256 === PL_LINES_SHA256), selector_check: Boolean(m?.selector_check.ok),
    tasks_frozen: Boolean(m && m.tasks.length === PL_TASKS), start_condition: start.open,
    worker_matches_manifest: Boolean(m?.harness && deploy.worker_sha256 && m.harness.endsWith(`:${deploy.worker_sha256}`)),
    deploy_matches_manifest: Boolean(m?.commit && deploy.commit && m.commit === deploy.commit),
  };
  return { checks, reason: validity.reason, start, manifest_sha256: m ? plManifestSha(m) : null, go: Object.values(checks).every(Boolean) };
}
