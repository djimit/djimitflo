import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';

/**
 * §16 step 8 (docs/research/intelligence-metrics/IMPLEMENTATION_PLAN.md): a SHADOW writer for `policy_violations`. The gates
 * already decide (refuse, fail, deny); this only records that a breach was detected, so SCIG (§16.12) has a monitored count
 * per kind instead of an empty table. It never blocks, never changes a gate result and never throws into the caller.
 *   POLICY_VIOLATION_LOG=shadow (default off)
 * One row per (kind, dedupe_key): a re-verify or a retried request of the same breach is the same violation, not a new one.
 * Row: action_type = kind, risk_level = severity, status = 'shadow', description = what was refused, created_at = when;
 * metadata = { actor, run_id, lease_id, task_id, evidence_ref, dedupe_key, source }. task_id is only set for a real task.
 */
export const POLICY_VIOLATION_KINDS = ['scope_gate', 'reviewer_read_only', 'diff_limit', 'runtime_admission', 'outbound_denied', 'content_unsafe', 'token_rejected'] as const;
export type PolicyViolationKind = (typeof POLICY_VIOLATION_KINDS)[number];
export type PolicyViolationSeverity = 'low' | 'medium' | 'high' | 'critical';

export const policyViolationLogEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.POLICY_VIOLATION_LOG === 'shadow';

export interface PolicyViolation {
  kind: PolicyViolationKind;
  actor: string;
  severity: PolicyViolationSeverity;
  description: string;
  dedupe_key: string;
  run_id?: string | null;
  lease_id?: string | null;
  task_id?: string | null;
  evidence_ref?: string | null;
  at?: string;
}

/** Hour bucket for dedupe keys of request-level refusals (tokens, outbound): one row per subject × reason × hour, not per request. */
export const hourBucket = (at: number = Date.now()): string => new Date(at).toISOString().slice(0, 13);

/** Records one shadow violation; true when a new row was written. Off, a duplicate, or any error → false. */
export function recordPolicyViolation(db: Database, v: PolicyViolation, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!policyViolationLogEnabled(env)) return false;
  try {
    const id = `pv-${createHash('sha256').update(`${v.kind}|${v.dedupe_key}`).digest('hex').slice(0, 24)}`;
    const at = v.at ?? new Date().toISOString();
    const metadata = { source: 'policy_violation_log', mode: 'shadow', actor: v.actor.slice(0, 200), run_id: v.run_id ?? null, lease_id: v.lease_id ?? null,
      task_id: v.task_id ?? null, evidence_ref: v.evidence_ref ?? null, dedupe_key: v.dedupe_key.slice(0, 300) };
    return db.prepare(`INSERT OR IGNORE INTO policy_violations (id, task_id, action_type, risk_level, status, description, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'shadow', ?, ?, ?, ?)`).run(id, v.task_id ?? null, v.kind, v.severity, v.description.slice(0, 500), JSON.stringify(metadata), at, at).changes > 0;
  } catch { return false; }
}

/** Shadow-log row counts per kind (all time); null when the table is absent. */
export function policyViolationCounts(db: Database): Record<string, number> | null {
  try {
    const rows = db.prepare("SELECT action_type AS kind, COUNT(*) AS n FROM policy_violations WHERE json_extract(metadata, '$.source') = 'policy_violation_log' GROUP BY action_type")
      .all() as Array<{ kind: string; n: number }>;
    return Object.fromEntries(POLICY_VIOLATION_KINDS.map((k) => [k, rows.find((r) => r.kind === k)?.n ?? 0]));
  } catch { return null; }
}
