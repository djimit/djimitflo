import type { Database } from 'better-sqlite3';
import { nonMakerRunSql } from './outcome-attribution';

/**
 * U1 (plan §0, Phase U): earned autonomy per narrow action class — measured, read-only. Every approval of the last 30 days is
 * classified as `role:lane:runtime` (lane from the proposal's evidence refs, else the loop) and scored by what the approved
 * work led to. A class has *earned* autonomy after >= 20 human approvals, 0 denied/expired and <= 1 regression. Nothing here
 * approves anything: acting on it (auto-approve with a 10 % human audit, revoked by one regression) is a separate, later step.
 */
export const EARN = { minApprovals: 20, maxRegressions: 1, windowDays: 30 };

/** non_maker (OUTCOME_ATTRIBUTION_ENABLED): regressions attributed to a reviewer or the environment — counted apart, never as a regression */
export interface ClassRecord { cls: string; human_approved: number; auto_approved: number; denied: number; expired: number; verified: number; regressed: number; non_maker: number; infra: number; pending: number; earned: boolean; why: string }

export function earnedAutonomy(db: Database, now = Date.now(), env: NodeJS.ProcessEnv = process.env): ClassRecord[] {
  const since = new Date(now - EARN.windowDays * 86_400_000).toISOString();
  let rows: Array<{ status: string; decided_by: string | null; role: string; runtime: string; loop_name: string | null; refs: string | null; improvement_status: string | null; gym_status: string | null; non_maker: number }> = [];
  try {
    rows = db.prepare(`SELECT a.status, a.decided_by, l.role, l.runtime, r.loop_name, s.evidence_refs_json AS refs, s.status AS improvement_status,
        json_extract(r.metadata, '$.gym_result.status') AS gym_status, ${nonMakerRunSql('r.id', env)} AS non_maker
      FROM approvals a
      JOIN worker_leases l ON json_extract(l.metadata, '$.execution_task_id') = a.task_id
      LEFT JOIN loop_runs r ON r.id = l.loop_run_id
      LEFT JOIN goals g ON g.id = r.goal_id
      LEFT JOIN self_improvements s ON s.id = g.improvement_id
      WHERE a.created_at >= ?`).all(since) as typeof rows;
  } catch { return []; }
  const lane = (r: (typeof rows)[number]) => {
    const refs = r.refs ?? '';
    if (refs.includes('mutation-gap:')) return 'mutation';
    if (refs.includes('#exports"')) return 'test-gap-exports';
    if (refs.includes('test-gap:')) return 'test-gap';
    if (r.loop_name === 'evolution-gym') return 'gym';
    return r.loop_name ?? 'unknown';
  };
  const by = new Map<string, ClassRecord>();
  for (const r of rows) {
    const cls = `${r.role}:${lane(r)}:${r.runtime}`;
    const c = by.get(cls) ?? { cls, human_approved: 0, auto_approved: 0, denied: 0, expired: 0, verified: 0, regressed: 0, non_maker: 0, infra: 0, pending: 0, earned: false, why: '' };
    const automated = /^(autonomy|inherit):/.test(r.decided_by ?? '');
    if (r.status === 'denied') c.denied++;
    else if (r.status === 'expired') c.expired++;
    else if (r.status === 'approved') {
      if (automated) c.auto_approved++; else c.human_approved++;
      const outcome = r.gym_status ?? r.improvement_status;
      if (outcome === 'verified' || outcome === 'success') c.verified++;
      else if ((outcome === 'regressed' || outcome === 'failure') && r.non_maker) c.non_maker++;
      else if (outcome === 'regressed' || outcome === 'failure') c.regressed++;
      else if (outcome === 'infra_failed') c.infra++;
      else c.pending++;
    }
    by.set(cls, c);
  }
  return [...by.values()].map((c) => {
    const gaps = [
      c.human_approved < EARN.minApprovals ? `${EARN.minApprovals - c.human_approved} more human approvals` : '',
      c.denied + c.expired > 0 ? `${c.denied} denied / ${c.expired} expired` : '',
      c.regressed > EARN.maxRegressions ? `${c.regressed} regressions (max ${EARN.maxRegressions})` : '',
    ].filter(Boolean);
    return { ...c, earned: gaps.length === 0, why: gaps.length ? gaps.join('; ') : 'earned' };
  }).sort((a, b) => Number(b.earned) - Number(a.earned) || b.human_approved - a.human_approved);
}
