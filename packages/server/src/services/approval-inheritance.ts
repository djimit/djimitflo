import type { Database } from 'better-sqlite3';

/**
 * D4 (operator 2026-09-28): a retry or evolve sibling does NOT inherit a human approval by default. It may only when ALL hold,
 * compared with a human-approved approval of an earlier maker on the same run:
 *   identical action   — same executionInputHash (what the executor was asked to run)
 *   risk               — same or lower risk_level
 *   scope              — same run, so the same goal and declared file scope
 *   target environment — same executorKind, executionMode and workspacePath
 *   freshness          — decided within APPROVAL_INHERIT_TTL_MS (default 2 h)
 * Automated decisions (`autonomy:*`) and earlier inheritances (`inherit:*`) never count as the human approval.
 * Off unless APPROVAL_INHERIT_ENABLED=true. The caller records the inheritance (decided_by `inherit:<original id>`).
 */
const RISK = ['low', 'medium', 'high', 'critical'];
interface ApprovalRow { id: string; status: string; risk_level: string; request_data: string; metadata: string | null; decided_by: string | null; decided_at: string | null }

function facts(row: ApprovalRow) {
  const meta = JSON.parse(row.metadata || '{}') as { executionInputHash?: string };
  const env = (JSON.parse(row.request_data || '{}') as { assessment?: { metadata?: Record<string, unknown> } }).assessment?.metadata ?? {};
  return { hash: meta.executionInputHash ?? null, risk: RISK.indexOf(row.risk_level), target: JSON.stringify([env.executorKind ?? null, env.executionMode ?? null, env.workspacePath ?? null]) };
}

/** The human approval a pending approval may inherit, or null (with the reason, for the evidence chain). */
export function inheritableApproval(db: Database, pendingApprovalId: string, runId: string, now = Date.now(), env: NodeJS.ProcessEnv = process.env): { originalId: string; reason: string } | null {
  if (env.APPROVAL_INHERIT_ENABLED !== 'true') return null;
  const ttl = Number(env.APPROVAL_INHERIT_TTL_MS) || 7_200_000;
  const pending = db.prepare('SELECT * FROM approvals WHERE id = ?').get(pendingApprovalId) as ApprovalRow | undefined;
  if (!pending || pending.status !== 'pending') return null;
  const want = facts(pending);
  if (!want.hash || want.risk < 0) return null;
  const taskIds = (db.prepare('SELECT metadata FROM worker_leases WHERE loop_run_id = ?').all(runId) as Array<{ metadata: string }>)
    .map((l) => (JSON.parse(l.metadata || '{}') as { execution_task_id?: string }).execution_task_id).filter((t): t is string => Boolean(t));
  if (!taskIds.length) return null;
  const candidates = db.prepare(`SELECT * FROM approvals WHERE task_id IN (${taskIds.map(() => '?').join(',')}) AND id != ? AND status = 'approved'
    AND decided_by IS NOT NULL AND decided_by NOT LIKE 'autonomy:%' AND decided_by NOT LIKE 'inherit:%' ORDER BY decided_at DESC`).all(...taskIds, pendingApprovalId) as ApprovalRow[];
  for (const c of candidates) {
    const have = facts(c);
    if (!c.decided_at || now - Date.parse(c.decided_at) > ttl) continue;
    if (have.hash === want.hash && want.risk <= have.risk && have.target === want.target) {
      return { originalId: c.id, reason: `D4 inheritance from human approval ${c.id} (${c.decided_by}, ${c.decided_at}): same action hash ${want.hash.slice(0, 12)}, risk ${pending.risk_level} <= ${c.risk_level}, same run scope and target` };
    }
  }
  return null;
}
