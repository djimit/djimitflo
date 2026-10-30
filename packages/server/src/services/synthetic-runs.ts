import type { Database } from 'better-sqlite3';

/**
 * U3 (B-intelligence 10-29): the GitHub PR-review webhook (routes/github-webhooks.ts → github-pr-review-service) writes a
 * repo-maintenance-loop run per PR head with a synthetic 'manual' maker lease and a heuristic (or LLM) checker — bookkeeping,
 * not loop work: 51 % of loop runs, 68 % of leases, 82 % of loop_verified events in prod. New runs are marked at write time
 * (metadata.synthetic = true, synthetic_reason 'pr_review'); older ones are recognised by loop_name 'repo-maintenance-loop'
 * plus a 'manual' maker lease (no data rewrite). Loop KPI aggregates count real runs only through these fragments.
 */
export type SyntheticReason = 'pr_review';

/** SQL: the loop_runs row `alias` is synthetic (marked, or a historical PR-review run). Never NULL. */
export const syntheticRunSql = (alias: string): string => `(COALESCE(json_extract(COALESCE(NULLIF(${alias}.metadata, ''), '{}'), '$.synthetic'), 0) = 1
  OR (${alias}.loop_name = 'repo-maintenance-loop' AND EXISTS (SELECT 1 FROM worker_leases syn_l WHERE syn_l.loop_run_id = ${alias}.id AND syn_l.role = 'maker' AND syn_l.runtime = 'manual')))`;

/** SQL: the loop_runs row `alias` (default: the unaliased table) is real loop work. */
export const realRunSql = (alias = 'loop_runs'): string => `NOT ${syntheticRunSql(alias)}`;

/** SQL for worker_leases / loop_events rows: `runIdExpr` names no synthetic run (a lease without a run stays in). */
export const realRunIdSql = (runIdExpr: string): string =>
  `NOT EXISTS (SELECT 1 FROM loop_runs syn_r WHERE syn_r.id = ${runIdExpr} AND ${syntheticRunSql('syn_r')})`;

/** Marks a run synthetic at write time (idempotent). */
export function markSyntheticRun(db: Database, runId: string, reason: SyntheticReason): void {
  db.prepare("UPDATE loop_runs SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.synthetic', json('true'), '$.synthetic_reason', ?) WHERE id = ?").run(reason, runId);
}
