import type { Database } from 'better-sqlite3';

/**
 * What a human needs to decide on a worker-execution approval: which goal/proposal it belongs to, what will run,
 * and where. The queue used to show only the policy text ("Matched policy: ..."), so an approval for an
 * autonomous maker looked identical to any other task and expired unseen (2026-09-21).
 */
export interface ApprovalContext {
  kind: 'loop_worker';
  goal_objective: string | null;
  proposal_title: string | null;
  loop_run_id: string;
  lease_role: string | null;
  runtime: string | null;
  working_directory: string | null;
  /** First part of the instruction the worker would receive. */
  prompt_preview: string | null;
}

export function approvalContext(db: Database, taskId: string): ApprovalContext | null {
  try {
    const task = db.prepare('SELECT description, metadata FROM tasks WHERE id = ?').get(taskId) as { description: string | null; metadata: string | null } | undefined;
    if (!task) return null;
    const meta = JSON.parse(task.metadata || '{}') as { loop_run_id?: string; lease_id?: string; workingDirectory?: string };
    if (!meta.loop_run_id) return null;
    const run = db.prepare('SELECT goal_id FROM loop_runs WHERE id = ?').get(meta.loop_run_id) as { goal_id: string | null } | undefined;
    const goal = run?.goal_id ? db.prepare('SELECT objective, improvement_id FROM goals WHERE id = ?').get(run.goal_id) as { objective: string | null; improvement_id: string | null } | undefined : undefined;
    const proposal = goal?.improvement_id ? db.prepare('SELECT title FROM self_improvements WHERE id = ?').get(goal.improvement_id) as { title: string } | undefined : undefined;
    const lease = meta.lease_id ? db.prepare('SELECT role, runtime FROM worker_leases WHERE id = ?').get(meta.lease_id) as { role: string; runtime: string } | undefined : undefined;
    return {
      kind: 'loop_worker',
      goal_objective: goal?.objective ? goal.objective.slice(0, 400) : null,
      proposal_title: proposal?.title ?? null,
      loop_run_id: meta.loop_run_id,
      lease_role: lease?.role ?? null,
      runtime: lease?.runtime ?? null,
      working_directory: meta.workingDirectory ?? null,
      prompt_preview: task.description ? task.description.slice(0, 500) : null,
    };
  } catch {
    return null; // context is a convenience; never break the approval queue over it
  }
}
