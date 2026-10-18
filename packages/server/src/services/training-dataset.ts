import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { redactSecrets } from './secret-patterns';
import { parseOutcome, settlementState } from './merge-survival';
import { parseSpecies } from './evolve-selection';
import { leaseGraded } from './graded-fitness';

/**
 * Training-dataset exporter (read-only) for a future maker fine-tune. Nothing trains and nothing leaves the machine: this
 * module only SELECTs; the CLI (scripts/export-training-dataset.ts) writes JSONL to an operator-given path.
 *
 * TRAINING_DATASET_EXPORT=off|shadow (default off). shadow: GET /api/health/training-dataset serves counts only (never a
 * diff) and the CLI may export.
 *
 * Rows:
 *  - prod: one per maker lease of an oracle-lane goal (proposal evidence test-gap / test-gap#exports / mutation-gap). The diff
 *    is taken only from what is durably stored (worker_leases.metadata.diff, loop_runs.metadata.diff); today neither is
 *    written, so prod rows carry diff null + diff_reason 'diff_not_stored' — never a git or GitHub read.
 *  - gym: gym_attempt_diffs joined to the run's gym_result (prod_gates, graded).
 * Never exported: TG-001 runs (loop_name 'tg-001' or gym.tg), canaries, every frozen holdout key (gym_holdout,
 * gym_mutant_holdout, gym_write_test_holdout, tg_attempts — and a prod run whose failure became one of those 'fail:<run>'
 * tasks), and any row whose target file is a frozen holdout task's file. Truncated diffs are kept out (counted). No
 * "unsafe redaction" flag exists in the schema (gym_attempt_diffs.redacted is a count), so every emitted diff is
 * re-redacted with redactSecrets and none is dropped for having been redacted.
 * Outcome ladder: true | false | null — null is unknown / not applicable, never coerced to false.
 * Split: sha256(target source file) → holdout for HOLDOUT_SHARE_PCT % of files, so a file is never in both splits.
 */
export type TrainingDatasetMode = 'off' | 'shadow';
export const trainingDatasetMode = (env: NodeJS.ProcessEnv = process.env): TrainingDatasetMode =>
  ((env.TRAINING_DATASET_EXPORT || '').trim().toLowerCase() === 'shadow' ? 'shadow' : 'off');

export const HOLDOUT_SHARE_PCT = 30;
/** Pre-registered readiness: ≥ 300 train rows with a diff over ≥ 200 tasks incl. ≥ 100 failures; holdout ≥ 100 tasks. */
export const READINESS_THRESHOLD = { train_rows_with_diff: 300, train_tasks: 200, train_failures: 100, holdout_tasks: 100 } as const;
export type Split = 'train' | 'holdout';
export type Lane = 'test-gap' | 'exports' | 'mutation-gap' | 'gym:mined' | 'gym:mutant' | 'gym:write_test';
export interface OutcomeLadder { executed_ok: boolean | null; prod_gates_pass: boolean | null; verified: boolean | null; merged: boolean | null; survived_14d: boolean | null }
export interface TrainingRow {
  source: 'prod' | 'gym'; task_key: string; lane: Lane; target_file: string; species: string | null; model: string | null;
  diff: string | null; diff_sha256: string | null; diff_reason: 'diff_not_stored' | null; redactions: number;
  outcome: OutcomeLadder; graded: number | null; split: Split; created_at: string; ref: string;
}
export type ExclusionReason = 'tg_001' | 'canary' | 'holdout_key' | 'holdout_file' | 'no_target_file' | 'truncated';
export interface TrainingDataset { rows: TrainingRow[]; excluded: Record<ExclusionReason, number>; unavailable: Array<'prod' | 'gym'> }

export function splitOf(targetFile: string): Split {
  return createHash('sha256').update(targetFile).digest().readUInt32BE(0) % 100 < HOLDOUT_SHARE_PCT ? 'holdout' : 'train';
}

const json = (text: unknown): Record<string, unknown> => {
  if (typeof text !== 'string' || !text) return {};
  try { const v = JSON.parse(text) as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { return {}; }
};
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Frozen holdout keys and the source/target files of frozen holdout tasks; a missing table contributes nothing. */
export function frozenHoldout(db: Database): { keys: Set<string>; files: Set<string> } {
  const keys = new Set<string>(); const files = new Set<string>();
  const read = (sql: string) => { try { return db.prepare(sql).all() as Array<{ k: string; t?: string | null }>; } catch { return []; } };
  for (const r of read('SELECT commit_sha AS k FROM gym_holdout')) keys.add(r.k);
  for (const r of read('SELECT task_key AS k FROM tg_attempts')) keys.add(r.k);
  for (const r of [...read('SELECT key AS k, task_json AS t FROM gym_mutant_holdout'), ...read('SELECT key AS k, task_json AS t FROM gym_write_test_holdout')]) {
    keys.add(r.k);
    const t = json(r.t);
    for (const f of [t.source, t.target]) if (str(f)) files.add(f as string);
  }
  return { keys, files };
}

function prodLane(evidence: string): { lane: Lane; key: string } | null {
  let refs: unknown;
  try { refs = JSON.parse(evidence); } catch { return null; }
  if (!Array.isArray(refs)) return null;
  const all = refs.map(String);
  const mut = all.find((r) => r.startsWith('mutation-gap:'));
  if (mut) return { lane: 'mutation-gap', key: mut };
  const tg = all.find((r) => r.startsWith('test-gap:'));
  return tg ? { lane: tg.includes('#exports') ? 'exports' : 'test-gap', key: tg } : null;
}

/** executed_ok from the maker lease: exit 0 and no timeout → true; a non-zero exit or a timeout → false; never ran → null. */
function leaseExecuted(m: Record<string, unknown>): boolean | null {
  if (m.timed_out === true || m.runtime_timed_out === true) return false;
  return typeof m.exit_status === 'number' ? m.exit_status === 0 : null;
}
/** prod_gates_pass from the maker's deterministic checks; a missing tool (127 / missing_script) is not a verdict → null. */
function checksPass(m: Record<string, unknown>): boolean | null {
  const checks = Array.isArray(m.deterministic_checks) ? m.deterministic_checks as Array<{ exit_status?: unknown; reason?: unknown }> : [];
  if (!checks.length || checks.some((c) => c?.exit_status === 127 || c?.reason === 'missing_script')) return null;
  if (checks.some((c) => typeof c?.exit_status === 'number' && c.exit_status !== 0)) return false;
  return checks.every((c) => c?.exit_status === 0) ? true : null;
}
/** merged / survived_14d from the E1 settlement state of the run's PR; no PR, open, pending or anomaly → null where unknown. */
export function mergeLadder(prUrl: unknown, prOutcome: unknown, createdAt: string, now: number): Pick<OutcomeLadder, 'merged' | 'survived_14d'> {
  if (!str(prUrl)) return { merged: null, survived_14d: null };
  const outcome = parseOutcome(prOutcome == null ? null : JSON.stringify(prOutcome));
  const s = settlementState(createdAt, outcome, now);
  switch (s.state) {
    case 'SETTLED_SURVIVED': return { merged: true, survived_14d: true };
    case 'SETTLED_REGRESSED': return { merged: true, survived_14d: false };
    case 'MERGED_SURVIVAL_PENDING': return { merged: true, survived_14d: null };
    case 'OPEN_BLOCKED': return { merged: s.terminal ? false : null, survived_14d: null };
    default: return { merged: outcome?.state === 'merged' ? true : null, survived_14d: null };
  }
}
const attributionVerified = (decision: string | null): boolean | null => (decision === 'verified' ? true : decision === 'maker_failure' ? false : null);

function redacted(diff: string): { diff: string; sha256: string; count: number } {
  const r = redactSecrets(diff);
  return { diff: r.redacted, sha256: createHash('sha256').update(r.redacted).digest('hex'), count: r.count };
}

export function buildTrainingDataset(db: Database, opts: { now?: number } = {}): TrainingDataset {
  const now = opts.now ?? Date.now();
  const holdout = frozenHoldout(db);
  const excluded: Record<ExclusionReason, number> = { tg_001: 0, canary: 0, holdout_key: 0, holdout_file: 0, no_target_file: 0, truncated: 0 };
  const unavailable: Array<'prod' | 'gym'> = [];
  const rows: TrainingRow[] = [];
  const admit = (target: string | null): target is string => {
    if (!target) { excluded.no_target_file++; return false; }
    if (holdout.files.has(target)) { excluded.holdout_file++; return false; }
    return true;
  };

  type ProdRow = { lease_id: string; runtime: string; lm: string; created_at: string; run_id: string; loop_name: string; rm: string; run_created_at: string;
    evidence: string; target: string | null; attribution: string | null };
  let prod: ProdRow[] = [];
  try {
    prod = db.prepare(`SELECT l.id AS lease_id, l.runtime, l.metadata AS lm, l.created_at, r.id AS run_id, r.loop_name, r.metadata AS rm, r.created_at AS run_created_at,
        s.evidence_refs_json AS evidence, json_extract(s.grounding_json, '$.target') AS target,
        (SELECT j.decision FROM judgments j WHERE j.judgment = 'outcome_attribution' AND j.subject_type = 'loop_run' AND j.subject_id = r.id
          ORDER BY j.created_at DESC LIMIT 1) AS attribution
      FROM worker_leases l JOIN loop_runs r ON r.id = l.loop_run_id JOIN goals g ON g.id = r.goal_id JOIN self_improvements s ON s.id = g.improvement_id
      WHERE l.role = 'maker' AND (s.evidence_refs_json LIKE '%"test-gap:%' OR s.evidence_refs_json LIKE '%"mutation-gap:%')
      ORDER BY l.created_at, l.id`).all() as ProdRow[];
  } catch { unavailable.push('prod'); }
  for (const p of prod) {
    const lane = prodLane(p.evidence ?? '');
    if (!lane) continue;
    if (p.loop_name === 'tg-001') { excluded.tg_001++; continue; }
    if (holdout.keys.has(`fail:${p.run_id}`)) { excluded.holdout_key++; continue; } // its failure is a frozen write_test / TG-001 task
    const target = str(p.target);
    if (!admit(target)) continue;
    const lm = json(p.lm); const rm = json(p.rm);
    if (lm.diff_truncated === true && str(lm.diff)) { excluded.truncated++; continue; } // same rule as gym rows: a cut patch is not a training example
    const stored = str(lm.diff) ?? str(rm.diff);
    const d = stored ? redacted(stored) : null;
    const model = str(lm.model);
    rows.push({
      source: 'prod', task_key: lane.key, lane: lane.lane, target_file: target, species: str(lm.species) ?? (model ? `${p.runtime}@${model}` : p.runtime), model,
      diff: d?.diff ?? null, diff_sha256: d?.sha256 ?? null, diff_reason: d ? null : 'diff_not_stored', redactions: d?.count ?? 0,
      outcome: { executed_ok: leaseExecuted(lm), prod_gates_pass: checksPass(lm), verified: attributionVerified(p.attribution), ...mergeLadder(rm.pr_url, rm.pr_outcome, p.run_created_at, now) },
      graded: leaseGraded(lm)?.score ?? null, split: splitOf(target), created_at: p.created_at, ref: `lease:${p.lease_id}`,
    });
  }

  type GymRow = { run_id: string; task_key: string; status: string; species: string | null; diff: string; redacted: number; truncated: number; created_at: string;
    loop_name: string | null; gym: string | null; result: string | null };
  let gym: GymRow[] = [];
  try {
    gym = db.prepare(`SELECT d.run_id, d.task_key, d.status, d.species, d.diff, d.redacted, d.truncated, d.created_at, r.loop_name,
        json_extract(r.metadata, '$.gym') AS gym, json_extract(r.metadata, '$.gym_result') AS result
      FROM gym_attempt_diffs d LEFT JOIN loop_runs r ON r.id = d.run_id ORDER BY d.created_at, d.run_id`).all() as GymRow[];
  } catch { unavailable.push('gym'); }
  for (const g of gym) {
    const task = json(g.gym); const result = json(g.result);
    if (g.loop_name === 'tg-001' || task.tg) { excluded.tg_001++; continue; }
    if (task.canary) { excluded.canary++; continue; }
    if (holdout.keys.has(g.task_key)) { excluded.holdout_key++; continue; }
    const kind = task.kind === 'write_test' ? 'write_test' : g.task_key.startsWith('mut:') || task.mutant !== undefined ? 'mutant' : 'mined';
    const target = kind === 'write_test' ? str(task.target) : str(task.source);
    if (!admit(target)) continue;
    if (g.truncated) { excluded.truncated++; continue; }
    const gates = result.prod_gates && typeof result.prod_gates === 'object' ? Object.values(result.prod_gates as Record<string, unknown>) : [];
    const d = redacted(g.diff);
    const species = str(g.species) ?? str(task.species);
    rows.push({
      source: 'gym', task_key: g.task_key, lane: `gym:${kind}`, target_file: target, species, model: species ? parseSpecies(species, 1)[0]?.model ?? null : null,
      diff: d.diff, diff_sha256: d.sha256, diff_reason: null, redactions: (Number(g.redacted) || 0) + d.count,
      outcome: { executed_ok: g.status === 'success' ? true : g.status === 'failure' ? false : null,
        prod_gates_pass: gates.includes('fail') ? false : gates.includes('pass') ? true : null, verified: null, merged: null, survived_14d: null },
      graded: typeof result.graded === 'number' && Number.isFinite(result.graded) ? result.graded : null, split: splitOf(target), created_at: g.created_at, ref: `loop_run:${g.run_id}`,
    });
  }
  return { rows, excluded, unavailable };
}

export type RowOutcome = 'success' | 'failure' | 'unknown';
/** failure = any rung explicitly false; success = none false and at least one true; unknown = every rung null. */
export function rowOutcome(o: OutcomeLadder): RowOutcome {
  const v = Object.values(o);
  return v.includes(false) ? 'failure' : v.includes(true) ? 'success' : 'unknown';
}

/** Counts only (no diff, no task text): what GET /api/health/training-dataset serves in shadow. */
export function trainingDatasetSummary(ds: TrainingDataset) {
  const sources = ['prod', 'gym'] as const; const splits = ['train', 'holdout'] as const;
  const totals = Object.fromEntries(sources.map((src) => [src, ds.unavailable.includes(src) ? null : Object.fromEntries(splits.map((sp) => {
    const rs = ds.rows.filter((r) => r.source === src && r.split === sp);
    return [sp, { rows: rs.length, success: rs.filter((r) => rowOutcome(r.outcome) === 'success').length, failure: rs.filter((r) => rowOutcome(r.outcome) === 'failure').length,
      unknown: rs.filter((r) => rowOutcome(r.outcome) === 'unknown').length }];
  }))]));
  const withDiff = ds.rows.filter((r) => r.diff !== null);
  const tasks = (rs: TrainingRow[]) => new Set(rs.map((r) => `${r.source}:${r.task_key}`)).size;
  const train = withDiff.filter((r) => r.split === 'train');
  const have = { train_rows_with_diff: train.length, train_tasks: tasks(train), train_failures: train.filter((r) => rowOutcome(r.outcome) === 'failure').length,
    holdout_tasks: tasks(withDiff.filter((r) => r.split === 'holdout')) };
  const missing = Object.fromEntries(Object.entries(READINESS_THRESHOLD).map(([k, t]) => [k, Math.max(0, t - have[k as keyof typeof have])])) as Record<keyof typeof have, number>;
  const ready = Object.values(missing).every((n) => n === 0);
  const prodRows = ds.unavailable.includes('prod') ? null : ds.rows.filter((r) => r.source === 'prod');
  return {
    totals, distinct_tasks: tasks(ds.rows), failures: ds.rows.filter((r) => rowOutcome(r.outcome) === 'failure').length,
    rows_with_diff: withDiff.length, redacted_rows: ds.rows.filter((r) => r.redactions > 0).length,
    prod_diff: prodRows ? { with_diff: prodRows.filter((r) => r.diff !== null).length, diff_not_stored: prodRows.filter((r) => r.diff_reason === 'diff_not_stored').length } : null,
    excluded: ds.excluded, unavailable: ds.unavailable,
    readiness: { status: ready ? 'READY' : ds.unavailable.length ? 'UNKNOWN' : 'NOT_READY', threshold: READINESS_THRESHOLD, have, missing, holdout_share_pct: HOLDOUT_SHARE_PCT },
    note: 'counts only; outcome rungs null = unknown (never false); split by sha256 of the target file; TG-001, canaries and frozen holdout keys/files never exported; UNKNOWN = a source table could not be read',
  };
}

/** Why an output path is refused (under /workspace or the repository, symlinks of the parent resolved), or null. */
export function refusedOutPath(out: string, repoRoot: string): string | null {
  const abs = path.resolve(out);
  let dir = path.dirname(abs);
  try { dir = fs.realpathSync(dir); } catch { /* parent missing: checked as given */ }
  const candidates = [abs, path.join(dir, path.basename(abs))];
  let realRepo = path.resolve(repoRoot);
  try { realRepo = fs.realpathSync(repoRoot); } catch { /* checked as given */ }
  const roots = [...new Set(['/workspace', path.resolve(repoRoot), realRepo])];
  const under = roots.find((r) => candidates.some((c) => c === r || c.startsWith(`${r}${path.sep}`)));
  return under ? `output path under ${under} is refused` : null;
}

/** The CLI body (scripts/export-training-dataset.ts). Exit: 0 written, 2 refused, 64 usage. Writes a NEW file only (never overwrites). */
export function runTrainingDatasetExport(argv: string[], env: NodeJS.ProcessEnv, repoRoot: string, log: (s: string) => void = console.log, err: (s: string) => void = console.error): number {
  const arg = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : ''; };
  const dbPath = arg('db'); const out = arg('out');
  if (!dbPath || !out) { err('usage: TRAINING_DATASET_EXPORT=shadow export-training-dataset --db <path> --out <file.jsonl>'); return 64; }
  if (trainingDatasetMode(env) !== 'shadow') { err('refused: TRAINING_DATASET_EXPORT is not shadow'); return 2; }
  const why = refusedOutPath(out, repoRoot);
  if (why) { err(`refused: ${why}`); return 2; }
  const db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
  try {
    const ds = buildTrainingDataset(db);
    fs.writeFileSync(out, ds.rows.map((r) => JSON.stringify(r)).join('\n') + (ds.rows.length ? '\n' : ''), { flag: 'wx', mode: 0o600 });
    log(JSON.stringify({ out: path.resolve(out), rows: ds.rows.length, ...trainingDatasetSummary(ds) }, null, 2));
    return 0;
  } finally { db.close(); }
}
