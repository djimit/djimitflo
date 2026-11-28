import type { Database } from 'better-sqlite3';
import { latestSkillRoute } from './skill-route';

/**
 * Execution receipt and trace lifecycle: a read-only projection over records that already exist (worker_leases, tasks,
 * execution_events, loop_runs, the skill route's assignment_context receipt). No table, no writer, no new trace store.
 *
 * Every field that was not observed is `null`, and a receipt is `verified` only when an independent checker and the daemon's
 * own check exit codes say so. A maker that reports success, a completed lease or a finished task alone is `unknown`
 * (UNKNOWN is not PASS). Used by the Commons signal bridge to decide whether an outcome may become a memory/skill candidate.
 */
export const TRACE_STATES = ['prepared', 'admitted', 'started', 'interrupted', 'resumed', 'completed', 'failed', 'cancelled', 'unknown'] as const;
export type TraceState = typeof TRACE_STATES[number];

type Json = Record<string, unknown>;
const json = (text: unknown): Json => { try { const v = JSON.parse(String(text ?? '')) as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {}; } catch { return {}; } };
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
// SQLite datetime('now') has no zone; both forms are UTC
const ms = (t: string) => Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t.replace(' ', 'T')}Z`);

/** Hours without an execution event after which a 'running' task is no longer known to run (same knob as the lease cleanup). */
export const staleRunningMs = (env: NodeJS.ProcessEnv = process.env): number => {
  const hours = Number(env.DJIMFLO_STALE_RUNNING_THRESHOLD_HOURS ?? 2);
  return (Number.isFinite(hours) && hours > 0 ? hours : 2) * 3_600_000;
};

export interface TraceEvent { event_type: string; timestamp: string; metadata?: string | null }
export interface Trace { task_id: string | null; state: TraceState; attempts: number; admitted_event_runtime: string | null; last_event_at: string | null; reason: string | null }

/**
 * prepared → admitted → started → completed | failed | cancelled, with interrupted / resumed around a pause, and unknown
 * for everything that cannot be told from the records: no task, a 'running' task without an engine admission, a 'running'
 * task whose last event is older than the stale threshold, and a restart whose external outcome nobody observed.
 */
export function traceLifecycle(task: { id: string; status: string; metadata?: string | null; updated_at?: string | null } | null | undefined, events: TraceEvent[], now = Date.now(), staleMs = staleRunningMs()): Trace {
  if (!task) return { task_id: null, state: 'unknown', attempts: 0, admitted_event_runtime: null, last_event_at: null, reason: 'no execution task recorded' };
  const admissions = events.map((e) => json(e.metadata)).filter((m) => m.source === 'execution-engine' && m.phase === 'admitted');
  const lastAdmissionAt = events.reduce((i, e, at) => (json(e.metadata).phase === 'admitted' ? at : i), -1);
  const last = events.at(-1)?.timestamp ?? task.updated_at ?? null;
  const base = { task_id: task.id, attempts: admissions.length, admitted_event_runtime: str(admissions.at(-1)?.executorKind), last_event_at: last };
  const as = (state: TraceState, reason: string | null = null): Trace => ({ ...base, state, reason });
  if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return as(task.status);
  if (task.status === 'paused') {
    return json(task.metadata).execution_recovery_outcome === 'unknown' || json(task.metadata).execution_recovery_reason === 'stale_running'
      ? as('unknown', 'ownership was lost; the external outcome was not observed') : as('interrupted');
  }
  if (task.status !== 'running') return as('prepared');
  if (!admissions.length) return as('unknown', 'running without an engine admission event');
  if (last === null || now - ms(last) > staleMs) return as('unknown', 'running, but no execution event within the stale threshold');
  if (admissions.length > 1 || events.some((e) => e.event_type === 'task.resumed')) return as('resumed');
  return as(lastAdmissionAt < events.length - 1 ? 'started' : 'admitted');
}

export function taskTrace(db: Database, taskId: string | null, now = Date.now(), staleMs = staleRunningMs()): Trace {
  if (!taskId) return traceLifecycle(null, [], now, staleMs);
  try {
    const task = db.prepare('SELECT id, status, metadata, updated_at FROM tasks WHERE id = ?').get(taskId) as { id: string; status: string; metadata: string | null; updated_at: string | null } | undefined;
    const events = db.prepare('SELECT event_type, timestamp, metadata FROM execution_events WHERE task_id = ? ORDER BY rowid').all(taskId) as TraceEvent[];
    return traceLifecycle(task, events, now, staleMs);
  } catch { return traceLifecycle(null, [], now, staleMs); }
}

export interface ExecutionReceipt {
  lease_id: string; run_id: string; role: string; lease_status: string;
  capability_id: string | null; source_revision: string | null; skill_hash: string | null;
  runtime_requested: string; runtime_observed: string | null; model: string | null;
  trace: Trace;
  verification: {
    run_status: string | null;
    checks: Array<{ name: string | null; exit_status: number | null }> | null;
    checker_lease_id: string | null; checker_verdict: string | null;
    /** the checker is another lease than the maker and names this maker; null when there is no checker lease */
    independent: boolean | null;
  };
  verdict: 'verified' | 'failed' | 'unknown';
  /** why the verdict is not `verified` */
  reasons: string[];
}

/** The receipt of one maker lease; null when the lease does not exist. */
export function executionReceipt(db: Database, leaseId: string, now = Date.now()): ExecutionReceipt | null {
  type Lease = { id: string; loop_run_id: string; role: string; runtime: string; status: string; capability_id: string | null; metadata: string };
  let lease: Lease | undefined; let checker: Lease | undefined; let run: { status: string } | undefined;
  try {
    lease = db.prepare('SELECT id, loop_run_id, role, runtime, status, capability_id, metadata FROM worker_leases WHERE id = ?').get(leaseId) as Lease | undefined;
    if (!lease) return null;
    checker = db.prepare("SELECT id, loop_run_id, role, runtime, status, capability_id, metadata FROM worker_leases WHERE loop_run_id = ? AND role = 'checker' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(lease.loop_run_id) as Lease | undefined;
    run = db.prepare('SELECT status FROM loop_runs WHERE id = ?').get(lease.loop_run_id) as { status: string } | undefined;
  } catch { return null; }
  const meta = json(lease.metadata);
  const skill = latestSkillRoute(db, lease.loop_run_id);
  const trace = taskTrace(db, str(meta.execution_task_id), now);
  const checks = Array.isArray(meta.deterministic_checks)
    ? meta.deterministic_checks.map((c) => { const o = json(JSON.stringify(c)); return { name: str(o.name), exit_status: typeof o.exit_status === 'number' ? o.exit_status : null }; })
    : null;
  const checkerMeta = json(checker?.metadata);
  const independent = checker ? checker.id !== lease.id && (str(checkerMeta.maker_lease_id) ?? lease.id) === lease.id : null;
  const verdictOf = str(checkerMeta.verdict);

  const failed: string[] = []; const missing: string[] = [];
  if (lease.status === 'failed' || lease.status === 'cancelled') failed.push(`lease ${lease.status}`);
  else if (lease.status !== 'completed') missing.push(`lease is ${lease.status}`);
  if (trace.state === 'failed' || trace.state === 'cancelled') failed.push(`trace ${trace.state}`);
  else if (trace.state !== 'completed') missing.push(`trace is ${trace.state}${trace.reason ? ` (${trace.reason})` : ''}`);
  if (!trace.admitted_event_runtime) missing.push('no observed runtime: the engine recorded no admission for this lease');
  if (!checks?.length) missing.push('no deterministic check result recorded');
  else if (checks.some((c) => c.exit_status !== null && c.exit_status !== 0)) failed.push('a deterministic check failed');
  else if (checks.some((c) => c.exit_status === null)) missing.push('a deterministic check has no exit status');
  if (!checker) missing.push('no checker lease');
  else if (!independent) missing.push('the checker is not independent of this maker');
  else if (verdictOf === 'rejected' || verdictOf === 'needs_revision') failed.push(`checker verdict ${verdictOf}`);
  else if (checker.status !== 'completed' || verdictOf !== 'accepted') missing.push(`checker verdict is ${verdictOf ?? 'not recorded'}`);
  if (!run || !['completed', 'ready_for_human_merge'].includes(run.status)) missing.push(`run is ${run?.status ?? 'not found'}`);

  return {
    lease_id: lease.id, run_id: lease.loop_run_id, role: lease.role, lease_status: lease.status,
    capability_id: lease.capability_id ?? skill?.capability_id ?? null,
    source_revision: str(json(JSON.stringify(meta.evidence_read_set ?? {})).base),
    skill_hash: skill?.artifact_digest ?? null,
    runtime_requested: lease.runtime, runtime_observed: trace.admitted_event_runtime, model: str(meta.model),
    trace,
    verification: { run_status: run?.status ?? null, checks, checker_lease_id: checker?.id ?? null, checker_verdict: verdictOf, independent },
    verdict: failed.length ? 'failed' : missing.length ? 'unknown' : 'verified',
    reasons: [...failed, ...missing],
  };
}

/** The receipt of a run's latest maker lease. */
export function runReceipt(db: Database, runId: string, now = Date.now()): ExecutionReceipt | null {
  try {
    const lease = db.prepare("SELECT id FROM worker_leases WHERE loop_run_id = ? AND role = 'maker' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(runId) as { id: string } | undefined;
    return lease ? executionReceipt(db, lease.id, now) : null;
  } catch { return null; }
}
