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

/** A deterministic 10 % of eligible PRs stays with the human: the audit sample that keeps the class honest. */
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
  let rows: Array<{ decision: string; mode: string; at: string | null; reason: string | null; settled: string | null }> = [];
  try {
    rows = db.prepare(`SELECT json_extract(metadata, '$.auto_merge.decision') AS decision, json_extract(metadata, '$.auto_merge.mode') AS mode,
      json_extract(metadata, '$.auto_merge.at') AS at, json_extract(metadata, '$.auto_merge.reason') AS reason, json_extract(metadata, '$.pr_outcome.settled_at') AS settled
      FROM loop_runs WHERE json_extract(metadata, '$.auto_merge.decision') IS NOT NULL`).all() as typeof rows;
  } catch { /* loop_runs absent */ }
  const d1 = new Date(now - 86_400_000).toISOString();
  const count = (decision: string) => rows.filter((r) => r.decision === decision).length;
  const reasons: Record<string, number> = {};
  for (const r of rows.filter((x) => x.decision === 'ineligible')) { const k = String(r.reason ?? '').split(':')[0]; reasons[k] = (reasons[k] ?? 0) + 1; }
  return {
    mode: autoMergeMode(env), max_per_day: autoMergeMaxPerDay(env), audit_sample_pct: AUDIT_SAMPLE_PCT, class: readClassState(db),
    counts: {
      merged: count('merged'), merged_24h: rows.filter((r) => r.decision === 'merged' && (r.at ?? '') >= d1).length,
      would_merge: count('would_merge'), audit_samples: count('audit_sample'),
      audit_samples_open: rows.filter((r) => r.decision === 'audit_sample' && !r.settled).length,
      waiting: count('waiting') + count('capped') + count('revoked_hold'), ineligible: count('ineligible'),
    },
    ineligible_by_reason: reasons,
  };
}
