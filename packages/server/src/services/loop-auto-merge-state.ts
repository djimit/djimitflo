import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import { AuditEventType, RiskLevel } from '@djimitflo/shared';
import { AuditService } from './audit-service';

/**
 * Earned auto-merge (operator 2026-10-07) — the class state and its evidence, kept apart from the GitHub-acting tick
 * (loop-auto-merge.ts) so the evidence endpoint and the digest can read it without importing the push path.
 * LOOP_AUTO_MERGE_TEST_ONLY = off (default) | shadow | act. The class is 'active' until a revert window trigger revokes it;
 * only an operator re-enables it (POST /api/loops/auto-merge/re-enable, manage:config, audited).
 */
export type AutoMergeMode = 'off' | 'shadow' | 'act';
export const autoMergeMode = (env: NodeJS.ProcessEnv = process.env): AutoMergeMode => {
  const v = String(env.LOOP_AUTO_MERGE_TEST_ONLY ?? '').trim().toLowerCase();
  return v === 'shadow' || v === 'act' ? v : 'off';
};
/** LOOP_AUTO_MERGE_MAX_PER_DAY (default 10, rolling 24 h; 0 = never). */
export const autoMergeMaxPerDay = (env: NodeJS.ProcessEnv = process.env): number => {
  const raw = env.LOOP_AUTO_MERGE_MAX_PER_DAY; const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 10;
};

/**
 * Re-evaluation of ineligible PRs (26-10: 20 of 40 open loop PRs were 'checks_failed' from days main CI was red for every PR,
 * and an ineligible decision was final). One explicit split of the ineligible reason codes (the text before ':'):
 * PERMANENT — the PR itself (or a human) must change; never re-checked. Unknown codes count as permanent (fail closed).
 * TRANSIENT — the cause can pass without the PR changing (main CI recovered, a GitHub hiccup, the proposal status, a verdict
 * not yet in the lease metadata); re-checked under LOOP_AUTO_MERGE_RECHECK=on. 'audit_sample' is a decision, not a reason:
 * it stays final (human by design). 'assertion_strength_missing' is re-read from the maker lease only — the offline
 * assertion_strength_retroactive judgments are never a runtime verdict (that evidence class is not merge authorization).
 */
export const PERMANENT_INELIGIBLE_REASONS = ['non_test_file', 'removes_test', 'diff_over_limit', 'changes_requested', 'not_loop_pr', 'repo_not_allowed',
  'assertion_strength_fail', 'assertion_strength_skipped', 'not_open', 'no_verified_head', 'merge_conflict'] as const;
export const TRANSIENT_INELIGIBLE_REASONS = ['checks_failed', 'head_moved', 'not_verified', 'files_unavailable', 'reviews_unavailable', 'github_unavailable',
  'assertion_strength_missing'] as const;
export const reasonCode = (reason: string | null | undefined): string => String(reason ?? '').split(':')[0].trim();
export const isTransientReason = (reason: string | null | undefined): boolean => (TRANSIENT_INELIGIBLE_REASONS as readonly string[]).includes(reasonCode(reason));
/** LOOP_AUTO_MERGE_RECHECK = off (default) | on. */
export const autoMergeRecheck = (env: NodeJS.ProcessEnv = process.env): boolean => String(env.LOOP_AUTO_MERGE_RECHECK ?? '').trim().toLowerCase() === 'on';
/** LOOP_AUTO_MERGE_RECHECK_HOURS (default 6): a transient ineligible PR is re-checked at most once per window. */
export const autoMergeRecheckHours = (env: NodeJS.ProcessEnv = process.env): number => {
  const raw = env.LOOP_AUTO_MERGE_RECHECK_HOURS; const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n > 0 ? n : 6;
};
/**
 * U2 (B-intelligence 10-29: 24/24 merges of the last 7 d were auto-merges on a label that cannot fail; 31/66 verified exports
 * tests kill < 20 % of seeded mutants): test-only eligibility additionally needs a value signal from the maker lease — the
 * fail-before-pass-after shadow verdict 'pass' against the parent source (FBPA_CHECK in deterministic_checks) OR a graded share
 * (metadata.graded kind mutant_kill on test-gap / exports, mutation_score on mutation) >= VALUE_KILL_SHARE_MIN. 'low' = a signal exists and says no
 * (FBPA fail, kill share below); 'missing' = neither was measured — unknown is never a pass.
 * LOOP_AUTO_MERGE_VALUE_GATE = off (default: not read) | shadow (the decision carries would_block_value, unchanged) | on
 * (ineligible: value_signal_missing / value_signal_low — not re-checked while on: the signals are written before the PR; after a
 * switch to off / shadow the next tick re-evaluates those PRs through every gate, so a rollback restores eligibility).
 */
export type ValueGateMode = 'off' | 'shadow' | 'on';
export const autoMergeValueGate = (env: NodeJS.ProcessEnv = process.env): ValueGateMode => {
  const v = String(env.LOOP_AUTO_MERGE_VALUE_GATE ?? '').trim().toLowerCase();
  return v === 'shadow' || v === 'on' ? v : 'off';
};
/**
 * LOOP_AUTO_MERGE_VALUE_GATE_LANES (operator 30-10: exports first — 70 % of exports PRs kill < 0.2 fresh mutants): a comma list
 * of oracle lanes (gym-failure-tasks oracleLane, the settlement lanes: exports | test-gap | mutation | other). With the gate on,
 * only PRs of a listed lane are blocked; every other lane is evaluated like shadow (would_block_value). Unset / empty = all lanes.
 */
export const autoMergeValueGateLanes = (env: NodeJS.ProcessEnv = process.env): string[] | null => {
  const lanes = String(env.LOOP_AUTO_MERGE_VALUE_GATE_LANES ?? '').split(',').map((l) => l.trim().toLowerCase()).filter(Boolean);
  return lanes.length ? lanes : null;
};
/** Whether the value gate acts (blocks) on a PR of this lane: on, and the lane is listed (or no list is set). */
export const valueGateActsOn = (mode: ValueGateMode, lanes: string[] | null, lane: string): boolean => mode === 'on' && (!lanes || lanes.includes(lane));
export const VALUE_KILL_SHARE_MIN = 0.2;
/** C4 (re-20261030): the one-off replay of the value gate on past auto-merges (auto-merge-value-replay.ts), shadow evidence only */
export const VALUE_GATE_REPLAY_JUDGMENT = 'auto_merge_value_gate_replay';
/** The value gate's own ineligible reasons: final while the gate is on, re-evaluated once it is off or shadow (rollback). */
export const VALUE_GATE_REASONS = ['value_signal_missing', 'value_signal_low'] as const;
const FBPA_CHECK_NAME = 'test:fail-before-pass-after'; // fail-before-pass-after.ts FBPA_CHECK (not imported: that module spawns test runs)
/**
 * re-20261030 (B §2): the graded share is the mutant kill share (test-gap / exports) or, on the mutation lane, the Stryker
 * mutation_score (after / 100) — both >= VALUE_KILL_SHARE_MIN. FBPA counts only when its fail-before ran against the parent
 * source: with before 'seeded_mutant' (test-only lanes) it reads the same graded seeded mutants (fail-before-pass-after.ts:145-149,
 * `failBefore = graded.killed > 0`, no second run; else one kill of the same targetMutants), so it is that signal again with
 * a threshold of one mutant, not an independent one.
 */
export function autoMergeValueSignal(checks: unknown, graded: unknown): 'pass' | 'low' | 'missing' {
  const rec = Array.isArray(checks) ? (checks as Array<{ name?: unknown; shadow_status?: unknown; before?: unknown } | null>).find((c) => c?.name === FBPA_CHECK_NAME) : undefined;
  const fbpa = rec && rec.before !== 'seeded_mutant' ? rec.shadow_status : undefined;
  const g = graded && typeof graded === 'object' ? graded as { kind?: unknown; score?: unknown } : null;
  const share = (g?.kind === 'mutant_kill' || g?.kind === 'mutation_score') && typeof g.score === 'number' && Number.isFinite(g.score) ? g.score : null;
  if (fbpa === 'pass' || (share !== null && share >= VALUE_KILL_SHARE_MIN)) return 'pass';
  return fbpa === 'fail' || share !== null ? 'low' : 'missing';
}

/** At most this many re-checks per tick (each is a handful of GitHub calls). */
export const RECHECK_PER_TICK = 5;

/** A deterministic 10 % of eligible PRs stays with the human: the audit sample that keeps the class honest. */
/**
 * P0-5: the commit status the PR-review webhook posts from its diff-size heuristic (github-pr-review-service). It is an
 * automated heuristic, never a human or independent review: auto-merge never counts it toward green (a 'failure' still blocks).
 */
export const PR_REVIEW_STATUS_CONTEXT = 'djimitflo-review';
export const AUDIT_SAMPLE_PCT = 10;
export const isAuditSample = (prNumber: number): boolean =>
  createHash('sha256').update(`loop-auto-merge:${prNumber}`).digest().readUInt32BE(0) % 100 < AUDIT_SAMPLE_PCT;

export interface ClassState { state: 'active' | 'revoked'; reason?: string; pr_url?: string; revoked_at?: string; re_enabled_by?: string; re_enabled_at?: string; re_enable_reason?: string }
const KEY = 'loop_auto_merge_test_only';
const ensure = (db: Database): void => {
  db.exec("CREATE TABLE IF NOT EXISTS system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
};

/** Missing row = active (never revoked). An unreadable row fails closed: revoked. */
export function readClassState(db: Database): ClassState {
  let row: { value: string } | undefined;
  try { row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(KEY) as { value: string } | undefined; } catch { return { state: 'active' }; }
  if (!row) return { state: 'active' };
  try {
    const s = JSON.parse(row.value) as ClassState;
    return s.state === 'active' || s.state === 'revoked' ? s : { state: 'revoked', reason: 'class state unreadable' };
  } catch { return { state: 'revoked', reason: 'class state unreadable' }; }
}

const write = (db: Database, s: ClassState, now: Date): void => {
  ensure(db);
  db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(KEY, JSON.stringify(s), now.toISOString());
};

/** Revoke the class (system actor). Returns false when it was already revoked (the first reason is kept). */
export function revokeClass(db: Database, reason: string, prUrl: string, now = new Date()): boolean {
  const before = readClassState(db);
  if (before.state === 'revoked') return false;
  const after: ClassState = { state: 'revoked', reason: reason.slice(0, 300), pr_url: prUrl, revoked_at: now.toISOString() };
  write(db, after, now);
  try {
    new AuditService(db).record({ event_type: AuditEventType.CONFIG_CHANGED, action: 'loop_auto_merge_revoked', resource_type: 'loop_auto_merge_class', resource_id: KEY,
      risk_level: RiskLevel.HIGH, before: { ...before }, after: { ...after }, metadata: { reason: after.reason, pr_url: prUrl } });
  } catch { /* the revoked state is persisted either way */ }
  return true;
}

/** Operator re-enable (manage:config at the route). Throws AUTO_MERGE_NOT_REVOKED when there is nothing to re-enable. */
export function reEnableClass(db: Database, actor: string, reason: string, now = new Date()): ClassState {
  const before = readClassState(db);
  if (before.state !== 'revoked') throw new Error('AUTO_MERGE_NOT_REVOKED');
  const after: ClassState = { state: 'active', re_enabled_by: actor, re_enabled_at: now.toISOString(), re_enable_reason: reason.slice(0, 500) };
  new AuditService(db).record({ event_type: AuditEventType.CONFIG_CHANGED, user_id: actor, action: 'loop_auto_merge_re_enabled', resource_type: 'loop_auto_merge_class',
    resource_id: KEY, risk_level: RiskLevel.HIGH, before: { ...before }, after: { ...after }, metadata: { reason: after.re_enable_reason } });
  write(db, after, now);
  return after;
}

/** Class state + counts for the cockpit, the evolution evidence and the digest. Fail-soft on a partial schema. */
export function autoMergeEvidence(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  let rows: Array<{ decision: string; mode: string; at: string | null; reason: string | null; settled: string | null; rechecked_at: string | null; would_block: string | null }> = [];
  try {
    rows = db.prepare(`SELECT json_extract(metadata, '$.auto_merge.decision') AS decision, json_extract(metadata, '$.auto_merge.mode') AS mode,
      json_extract(metadata, '$.auto_merge.at') AS at, json_extract(metadata, '$.auto_merge.reason') AS reason, json_extract(metadata, '$.pr_outcome.settled_at') AS settled,
      json_extract(metadata, '$.auto_merge.rechecked_at') AS rechecked_at, json_extract(metadata, '$.auto_merge.would_block_value') AS would_block
      FROM loop_runs WHERE json_extract(metadata, '$.auto_merge.decision') IS NOT NULL`).all() as typeof rows;
  } catch { /* loop_runs absent */ }
  let replay: Array<{ decision: string; n: number }> = [];
  try { replay = db.prepare('SELECT decision, COUNT(*) AS n FROM judgments WHERE judgment = ? GROUP BY decision').all(VALUE_GATE_REPLAY_JUDGMENT) as typeof replay; } catch { /* judgments absent */ }
  const replayed = (d: string) => replay.find((r) => r.decision === d)?.n ?? 0;
  const d1 = new Date(now - 86_400_000).toISOString();
  const count = (decision: string) => rows.filter((r) => r.decision === decision).length;
  const reasons: Record<string, number> = {};
  for (const r of rows.filter((x) => x.decision === 'ineligible')) { const k = String(r.reason ?? '').split(':')[0]; reasons[k] = (reasons[k] ?? 0) + 1; }
  // latest decision × reason code, the ineligible split permanent vs transient, and the PRs re-checked in the last 24 h
  const byDecisionReason: Record<string, Record<string, number>> = {};
  for (const r of rows) { const d = (byDecisionReason[r.decision] ??= {}); const k = reasonCode(r.reason); d[k] = (d[k] ?? 0) + 1; }
  const ineligible = rows.filter((r) => r.decision === 'ineligible');
  const transient = ineligible.filter((r) => isTransientReason(r.reason)).length;
  const rechecked = rows.filter((r) => (r.rechecked_at ?? '') >= d1);
  const recheckedByDecision: Record<string, number> = {};
  for (const r of rechecked) recheckedByDecision[r.decision] = (recheckedByDecision[r.decision] ?? 0) + 1;
  return {
    mode: autoMergeMode(env), max_per_day: autoMergeMaxPerDay(env), audit_sample_pct: AUDIT_SAMPLE_PCT, class: readClassState(db),
    counts: {
      merged: count('merged'), merged_24h: rows.filter((r) => r.decision === 'merged' && (r.at ?? '') >= d1).length,
      would_merge: count('would_merge'), audit_samples: count('audit_sample'),
      audit_samples_open: rows.filter((r) => r.decision === 'audit_sample' && !r.settled).length,
      waiting: count('waiting') + count('capped') + count('revoked_hold'), ineligible: count('ineligible'),
    },
    ineligible_by_reason: reasons,
    // U2: what the value gate blocks (on: ineligible reasons) or would block (shadow: decisions carrying would_block_value)
    value_gate: { mode: autoMergeValueGate(env), lanes: autoMergeValueGateLanes(env) ?? 'all', kill_share_min: VALUE_KILL_SHARE_MIN,
      would_block: { value_signal_missing: rows.filter((r) => r.would_block === 'value_signal_missing').length, value_signal_low: rows.filter((r) => r.would_block === 'value_signal_low').length },
      // C4: the operator-run replay of the rule on past auto-merges (shadow judgments, replay: true); n 0 = not run
      replay: { n: replay.reduce((a, r) => a + r.n, 0), pass: replayed('pass'), low: replayed('low'), missing: replayed('missing') } },
    recheck: {
      enabled: autoMergeRecheck(env), window_hours: autoMergeRecheckHours(env), per_tick: RECHECK_PER_TICK,
      ineligible_by_class: { permanent: ineligible.length - transient, transient },
      by_decision_reason: byDecisionReason,
      rechecked_24h: rechecked.length, rechecked_24h_by_decision: recheckedByDecision,
    },
  };
}
