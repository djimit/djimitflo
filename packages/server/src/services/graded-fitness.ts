import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Database } from 'better-sqlite3';
import { laneOf, targetMutants } from './gym-failure-tasks';

/**
 * SI-A graded executed fitness (operator Phase SI, prod 08-10): pass/fail saturates — gym 83.6 % success, failure-derived
 * write_test tasks 18/22 pass but only 8/22 kill all 3 seeded mutants, and production evolve contests are decided by diff
 * size. A graded score in [0, 1] says HOW well a scored attempt did, from executed tests only:
 *   mutant_kill  write_test (gym) / test-gap + exports makers (prod): killed / seeded mutants of the target
 *   tests_green  repair (gym mined + mutant): share of the oracle tests red at the start and green after
 *   binary       repair without a per-test report: 1 / 0 from the verdict
 * Contract: a skill_outcomes evidence ref `graded:<0..1, 3 decimals>` plus `graded_kind:<kind>` (prod adds
 * `graded_lane:<test-gap|exports>`). GRADED_FITNESS_MODE=off|shadow (default off): records only; nothing reads it for a
 * decision except the contest below when its own flag is set.
 * SI-B GRADED_CONTEST_MODE=off|shadow|act (default off): evolve selection by graded score (evolve-selection.ts).
 */
export type GradedKind = 'mutant_kill' | 'tests_green' | 'binary';
const KINDS = new Set<GradedKind>(['mutant_kill', 'tests_green', 'binary']);
export const gradedFitnessMode = (env: NodeJS.ProcessEnv = process.env): 'off' | 'shadow' => (env.GRADED_FITNESS_MODE === 'shadow' ? 'shadow' : 'off');
export const gradedContestMode = (env: NodeJS.ProcessEnv = process.env): 'off' | 'shadow' | 'act' =>
  (env.GRADED_CONTEST_MODE === 'shadow' || env.GRADED_CONTEST_MODE === 'act' ? env.GRADED_CONTEST_MODE : 'off');

export const roundGraded = (score: number): number => +Math.min(1, Math.max(0, score)).toFixed(3);
export function gradedRefs(score: number, kind: GradedKind): string[] {
  if (!Number.isFinite(score) || !KINDS.has(kind)) return [];
  return [`graded:${roundGraded(score).toFixed(3)}`, `graded_kind:${kind}`];
}
export function parseGraded(refs: string[]): { score: number; kind: GradedKind } | null {
  const raw = refs.find((r) => r.startsWith('graded:'))?.slice(7); const kind = refs.find((r) => r.startsWith('graded_kind:'))?.slice(12) as GradedKind | undefined;
  const score = raw !== undefined && /^[01]\.\d{3}$/.test(raw) ? Number(raw) : NaN;
  return Number.isFinite(score) && score <= 1 && kind && KINDS.has(kind) ? { score, kind } : null;
}

/** What a maker lease stores under metadata.graded: a score, or why there is none (so it is computed once). */
export interface LeaseGraded { score?: number; kind?: 'mutant_kill'; lane?: string; killed?: number; total?: number; skipped?: string; ms: number }
export function leaseGraded(meta: { graded?: unknown }): { score: number; kind: GradedKind; lane?: string } | null {
  const g = meta.graded as LeaseGraded | undefined;
  return g && typeof g.score === 'number' && Number.isFinite(g.score) && g.kind ? { score: roundGraded(g.score), kind: g.kind, ...(g.lane ? { lane: g.lane } : {}) } : null;
}
export function leaseGradedRefs(meta: { graded?: unknown }): string[] {
  const g = leaseGraded(meta);
  return g ? [...gradedRefs(g.score, g.kind), ...(g.lane ? [`graded_lane:${g.lane}`] : [])] : [];
}

/** One vitest run of the maker's test file in packages/server: pass | fail | timeout. Injectable for tests. */
export type KillRunner = (cwd: string, test: string, timeoutMs: number) => 'pass' | 'fail' | 'timeout';
const vitestRunner: KillRunner = (cwd, test, timeoutMs) => {
  const r = spawnSync('npx', ['vitest', 'run', test], { cwd, timeout: timeoutMs, encoding: 'utf8', stdio: 'ignore', env: process.env });
  if (r.error || r.signal) return 'timeout';
  return r.status === 0 ? 'pass' : 'fail';
};
/** Whole kill-share step per maker: baseline + up to 3 mutants share this budget. */
export const GRADED_KILL_BUDGET_MS = 120_000;
const TEST = /^packages\/server\/src\/__tests__\/([\w-]+)(?:\.[\w-]+)?\.test\.ts$/;
const TARGET = /^packages\/server\/src\/services\/[\w-]+\.ts$/;

/**
 * SI-A prod (GRADED_FITNESS_MODE=shadow): a gate-passing test-gap / exports maker whose diff adds or changes a test file
 * gets the kill share of <= 3 seeded single-operator mutants of the target (gym-failure-tasks targetMutants, the helper
 * the gym's write_test tasks use). Baseline must be green; only that test file runs; GRADED_KILL_BUDGET_MS in total.
 * Stored on the lease (metadata.graded), read by evolve selection and the maker outcome. A timeout, a red baseline or any
 * error stores a reason and no score — it never fails the run. Idempotent.
 */
export function recordMakerGraded(db: Database, runId: string, leaseId: string, opts: { env?: NodeJS.ProcessEnv; run?: KillRunner; budgetMs?: number } = {}): void {
  if (gradedFitnessMode(opts.env ?? process.env) !== 'shadow') return;
  const started = Date.now();
  let lease: { status: string; worktree_path: string | null; metadata: string } | undefined;
  try { lease = db.prepare("SELECT status, worktree_path, metadata FROM worker_leases WHERE id = ? AND role = 'maker'").get(leaseId) as typeof lease; } catch { return; }
  if (!lease || lease.status !== 'completed' || !lease.worktree_path) return; // only a maker that passed its checks
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(lease.metadata || '{}'); } catch { return; }
  if (meta.graded) return;
  const proposal = db.prepare(`SELECT s.evidence_refs_json AS evidence, json_extract(s.grounding_json, '$.artifactPath') AS artifact, json_extract(s.grounding_json, '$.target') AS target
    FROM loop_runs r JOIN goals g ON g.id = r.goal_id JOIN self_improvements s ON s.id = g.improvement_id WHERE r.id = ?`).get(runId) as { evidence: string | null; artifact: string | null; target: string | null } | undefined;
  const lane = proposal ? laneOf(proposal.evidence ?? '') : null;
  if (!lane) return;
  const changed = Array.isArray(meta.changed_files) ? (meta.changed_files as unknown[]).map(String) : [];
  const test = proposal?.artifact && changed.includes(proposal.artifact) && TEST.test(proposal.artifact) ? proposal.artifact : changed.find((f) => TEST.test(f));
  if (!test) return;
  const wt = lease.worktree_path;
  const target = proposal?.target && TARGET.test(proposal.target) ? proposal.target : `packages/server/src/services/${TEST.exec(test)![1]}.ts`;
  const store = (g: Omit<LeaseGraded, 'ms'>) => {
    try { db.prepare("UPDATE worker_leases SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.graded', json(?)) WHERE id = ?").run(JSON.stringify({ ...g, ms: Date.now() - started }), leaseId); } catch { /* evidence only */ }
  };
  const file = path.join(wt, target);
  let original: string;
  try { original = fs.readFileSync(file, 'utf8'); } catch { return store({ skipped: 'target missing' }); }
  const mutants = targetMutants(original, runId, target);
  if (!mutants.length) return store({ skipped: 'no mutant' });
  const run = opts.run ?? vitestRunner; const budget = opts.budgetMs ?? GRADED_KILL_BUDGET_MS;
  const cwd = path.join(wt, 'packages/server'); const rel = test.replace(/^packages\/server\//, '');
  const left = () => budget - (Date.now() - started);
  let killed = 0;
  try {
    const base = run(cwd, rel, left());
    if (base === 'timeout') return store({ skipped: 'timeout' });
    if (base !== 'pass') return store({ skipped: 'baseline red' });
    for (const m of mutants) {
      if (left() <= 0) return store({ skipped: 'timeout' });
      fs.writeFileSync(file, m.content);
      const r = run(cwd, rel, left());
      if (r === 'timeout') return store({ skipped: 'timeout' });
      if (r === 'fail') killed++;
    }
  } catch (error) {
    return store({ skipped: `error: ${(error instanceof Error ? error.message : String(error)).slice(0, 80)}` });
  } finally {
    try { fs.writeFileSync(file, original); } catch { /* the reviewers see a broken target; nothing more can be done */ }
  }
  store({ score: roundGraded(killed / mutants.length), kind: 'mutant_kill', lane, killed, total: mutants.length });
}

/** SI-A/SI-B evidence: graded outcomes per pool and how often the graded contest winner agrees with the current rule. */
export function gradedEvidence(db: Database, since: string, env: NodeJS.ProcessEnv = process.env) {
  let rows: Array<{ domain: string; refs: string }> = [];
  try { rows = db.prepare(`SELECT domain, evidence_refs_json AS refs FROM skill_outcomes WHERE created_at >= ? AND evidence_refs_json LIKE '%"graded:%' LIMIT 20000`).all(since) as typeof rows; } catch { /* no table */ }
  const pools: Record<string, number[]> = { gym_write_test: [], gym_repair: [], prod_test_gap: [], prod_exports: [] };
  for (const r of rows) {
    let refs: string[] = [];
    try { refs = JSON.parse(r.refs); } catch { continue; }
    const g = Array.isArray(refs) ? parseGraded(refs.map(String)) : null;
    if (!g) continue;
    const pool = r.domain === 'gym' ? (refs.includes('gym:fail') ? 'gym_write_test' : 'gym_repair')
      : refs.includes('graded_lane:exports') ? 'prod_exports' : refs.includes('graded_lane:test-gap') ? 'prod_test_gap' : null;
    if (pool) pools[pool].push(g.score);
  }
  let contests: Array<{ agree: number | null }> = [];
  try { contests = db.prepare("SELECT json_extract(metadata, '$.agree') AS agree FROM loop_events WHERE event_type = 'contest_graded' AND created_at >= ?").all(since) as typeof contests; } catch { /* no table */ }
  const agree = contests.filter((c) => c.agree === 1).length;
  return {
    mode: { fitness: gradedFitnessMode(env), contest: gradedContestMode(env) },
    pools: Object.entries(pools).map(([pool, s]) => ({ pool, n: s.length, mean: s.length ? roundGraded(s.reduce((a, b) => a + b, 0) / s.length) : null, share_full: s.length ? roundGraded(s.filter((x) => x >= 1).length / s.length) : null })),
    contest: { contests: contests.length, agree, agreement_rate: contests.length ? roundGraded(agree / contests.length) : null },
  };
}
