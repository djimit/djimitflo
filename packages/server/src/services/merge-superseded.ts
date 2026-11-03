import type { Database } from 'better-sqlite3';

/**
 * Prod 19-10: 4 of 16 merge outcomes were `pr_outcome:closed_unmerged` zeros for loop PRs the operator's agent closed as
 * SUPERSEDED — the proposal had been requeued (improvement-requeue, `requeue-of:<id>` in the copy's
 * self_improvements.evidence_refs_json) and the copy verified and opened a replacement PR. That close is bookkeeping, not a
 * human rejection, so it is no merge verdict. One rule for the poller (no outcome written) and every reader of domain 'merge'
 * outcomes (historical rows left out), so old and new rows agree:
 *
 *   a loop run's PR closed unmerged is SUPERSEDED when its proposal (goals.improvement_id) has a requeue descendant
 *   (requeue-of followed transitively) whose status reached verified (verified / evaluating / applied) or which has a loop
 *   run with its own PR.
 *
 * A closed-unmerged PR without such a successor stays a scored 0 (genuine rejection).
 */
const REACHED_VERIFIED = "('verified', 'evaluating', 'applied')";

/** SQL scalar: the earliest qualifying requeue successor (self_improvements.id) of the run `runExpr`'s proposal, else NULL. */
export function supersedingProposalSql(runExpr: string): string {
  return `(WITH RECURSIVE sup_d(id) AS (
      SELECT sup_g.improvement_id FROM loop_runs sup_r JOIN goals sup_g ON sup_g.id = sup_r.goal_id WHERE sup_r.id = ${runExpr} AND sup_g.improvement_id IS NOT NULL
      UNION
      SELECT sup_s.id FROM self_improvements sup_s JOIN sup_d ON instr(sup_s.evidence_refs_json, '"requeue-of:' || sup_d.id || '"') > 0)
    SELECT sup_c.id FROM sup_d JOIN self_improvements sup_c ON sup_c.id = sup_d.id
    WHERE sup_c.id NOT IN (SELECT sup_g0.improvement_id FROM loop_runs sup_r0 JOIN goals sup_g0 ON sup_g0.id = sup_r0.goal_id WHERE sup_r0.id = ${runExpr} AND sup_g0.improvement_id IS NOT NULL)
      AND (sup_c.status IN ${REACHED_VERIFIED} OR EXISTS (SELECT 1 FROM goals sup_g2 JOIN loop_runs sup_r2 ON sup_r2.goal_id = sup_g2.id
        WHERE sup_g2.improvement_id = sup_c.id AND sup_r2.id <> ${runExpr} AND json_extract(sup_r2.metadata, '$.pr_url') IS NOT NULL))
    ORDER BY sup_c.created_at, sup_c.id LIMIT 1)`;
}

/**
 * SQL boolean for a skill_outcomes row (`alias`): a domain 'merge' outcome whose run's PR was closed unmerged and is
 * superseded by a requeue. Readers of merge outcomes add `AND NOT ${supersededMergeOutcomeSql(alias)}`.
 */
export function supersededMergeOutcomeSql(alias: string): string {
  return `(${alias}.domain = 'merge' AND EXISTS (SELECT 1 FROM loop_runs sup_x WHERE sup_x.id = ${alias}.task_id
    AND json_extract(sup_x.metadata, '$.pr_outcome.state') = 'closed_unmerged') AND ${supersedingProposalSql(`${alias}.task_id`)} IS NOT NULL)`;
}

/** The poller's check for one run: the successor proposal id, or null (no successor, or the lineage tables are unreadable). */
export function supersedingProposal(db: Database, runId: string): string | null {
  try { return (db.prepare(`SELECT ${supersedingProposalSql('@run')} AS id`).get({ run: runId }) as { id: string | null }).id ?? null; }
  catch { return null; }
}
