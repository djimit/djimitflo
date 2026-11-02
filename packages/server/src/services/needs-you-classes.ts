import type { Database } from 'better-sqlite3';
import type { DecisionsInbox } from './decisions-inbox';
import { dependencyLaneQueue, laneMode } from './dependency-lane';
import { e1LabelQueue } from './e1-retrieval-labels';
import { relevanceQueue } from './discovery-relevance-labels';

/**
 * Human-only needs-you (operator 2026-10-26: "only big changes are tasked to me"). The headline count and the Telegram
 * digest/triage count HUMAN_DECISION items only:
 *   pending approvals (incl. Commons join and fleet shell requests) · the loop-PR audit sample (weekly batch) · Dependabot
 *   PRs the dependency lane leaves to a human (major, non-npm, unparseable bump) · memory candidates in review that are
 *   not template duplicates · flagged loop PRs (open, not an audit sample: the auto-merge lane did not take them) ·
 *   requeue rows no system handles (see openDecisionCounts).
 * Ground-truth labelling (D5 pre-screen, CAR attribution audit, E1 retrieval, DI-001 relevance) is OPTIONAL LABELLING: its
 * own count, never part of the decisions total. null = that count could not be read — never shown as 0.
 */
export interface OptionalLabelling { d5: number | null; car: number | null; e1: number | null; di001: number | null; total: number | null }

const sum = (xs: Array<number | null>): number | null => (xs.some((x) => x === null) ? null : (xs as number[]).reduce((a, b) => a + b, 0));

export function optionalLabelling(db: Database, inbox: DecisionsInbox | null, now = Date.now()): OptionalLabelling {
  const d5 = inbox ? inbox.totals.prescreen_unlabelled : null;
  const car = inbox ? inbox.attribution_audit.items.filter((i) => !i.verdict).length : null;
  const e1 = (() => { try { const p = e1LabelQueue(db).progress; return Math.max(0, p.tasks - p.labelled); } catch { return null; } })();
  // DI-001: the protected sample still unlabelled plus the relabels due (the AL top-up is open-ended, not a backlog)
  const di001 = (() => { try { const p = relevanceQueue(db, 1, now).progress; return Math.max(0, p.protected.total - p.protected.labelled) + p.relabel.due; } catch { return null; } })();
  return { d5, car, e1, di001, total: sum([d5, car, e1, di001]) };
}

/** Open loop PRs split into the audit sample (10 % kept for the human, reviewed as one weekly batch) and the rest (flagged). */
export function openLoopPrSplit(db: Database): { audit_batch: number | null; flagged_prs: number | null } {
  try {
    const r = db.prepare(`SELECT COUNT(*) AS open, COALESCE(SUM(json_extract(metadata, '$.auto_merge.decision') = 'audit_sample'), 0) AS audit FROM loop_runs
      WHERE json_extract(metadata, '$.pr_url') IS NOT NULL AND COALESCE(json_extract(metadata, '$.pr_outcome.state'), 'open') = 'open'`).get() as { open: number; audit: number };
    return { audit_batch: r.audit, flagged_prs: r.open - r.audit };
  } catch { return { audit_batch: null, flagged_prs: null }; }
}

/** Lane decisions that leave a Dependabot PR to the human (dependency-lane.ts: only npm patch/minor is the lane's). */
export const DEPENDENCY_HUMAN_DECISIONS = ['skip_not_npm', 'skip_major', 'skip_unknown_bump'];
/** tracked = the lane runs (mode not off); with the lane off Dependabot PRs are not tracked here, so the count is not 0 but absent. */
export function dependencyHuman(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()): { count: number | null; tracked: boolean } {
  if (laneMode(env) === 'off') return { count: null, tracked: false };
  try { return { count: dependencyLaneQueue(db, env, now).rows.filter((r) => DEPENDENCY_HUMAN_DECISIONS.includes(r.decision)).length, tracked: true }; }
  catch { return { count: null, tracked: true }; }
}
