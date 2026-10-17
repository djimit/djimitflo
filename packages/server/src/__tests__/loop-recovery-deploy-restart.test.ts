import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopRecoveryService } from '../services/loop-recovery-service';
import { detectStallsWithHealth } from '../services/stall-watch';

/**
 * Incident 17-10 (prod): three local doc-drift makers started 00:06Z, were auto-approved, and the deploy restart at 00:36Z
 * killed their engine tasks. The runs stayed 'running' with every lease 'prepared', goals 'blocked' on an approval that was
 * already approved, proposals 'executing' — 15 h, filling TEST_GAP_MAX_IN_FLIGHT.
 */
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); });
afterEach(() => db.close());

const STARTED = '2026-10-17T00:06:00.000Z';
const BOOT = '2026-10-17T00:36:30.000Z';

function seed(id: string, opts: { approval?: 'pending' | 'approved'; taskStatus?: string; goalStatus?: string; leaseStatus?: string; runtime?: string; runMeta?: object; at?: string } = {}) {
  const at = opts.at ?? STARTED;
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, grounding_json, created_at, updated_at)
    VALUES (?, 'test', 't', 'd', 'r', 'test-gap', 'executing', 0.5, '[]', '{}', ?, ?)`).run(`p-${id}`, at, at);
  const waiting = opts.approval ? { awaiting_approval: { approval_id: `a-${id}`, run_id: `r-${id}`, lease_id: `l-${id}`, since: at } } : {};
  db.prepare("INSERT INTO goals (id, objective, risk_class, status, improvement_id, metadata, created_at, updated_at) VALUES (?, 'o', 'low', ?, ?, ?, ?, ?)")
    .run(`g-${id}`, opts.goalStatus ?? 'blocked', `p-${id}`, JSON.stringify(waiting), at, at);
  db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, metadata, created_at, updated_at) VALUES (?, ?, 'doc-drift-and-small-fix-loop', 'closed', 'running', ?, ?, ?)")
    .run(`r-${id}`, `g-${id}`, JSON.stringify(opts.runMeta ?? {}), at, at);
  db.prepare("INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, metadata, created_at, updated_at) VALUES (?, 'maker', 'p', ?, 'low', 'low', 'local', '{}', ?, ?)")
    .run(`t-${id}`, opts.taskStatus ?? 'running', at, at);
  if (opts.approval) {
    db.prepare(`INSERT INTO approvals (id, task_id, status, risk_level, request_type, request_message, request_data, requested_by)
      VALUES (?, ?, ?, 'low', 'high_risk_action', 'm', '{}', 'system')`).run(`a-${id}`, `t-${id}`, opts.approval);
  }
  for (const role of ['maker', 'checker']) {
    db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(role === 'maker' ? `l-${id}` : `lc-${id}`, `r-${id}`, role, opts.runtime ?? 'codex', role === 'maker' ? (opts.leaseStatus ?? 'prepared') : 'prepared',
        JSON.stringify(role === 'maker' ? { execution_task_id: `t-${id}` } : {}), at, at);
  }
  db.prepare("INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (?, ?, 'goal_awaiting_approval', 'warning', 'm', '{}', ?)")
    .run(`e-${id}`, `r-${id}`, at);
}

const row = (table: string, id: string) => db.prepare(`SELECT status, metadata FROM ${table} WHERE id = ?`).get(id) as { status: string; metadata: string };
const proposal = (id: string) => (db.prepare('SELECT status FROM self_improvements WHERE id = ?').get(`p-${id}`) as { status: string }).status;
const recover = () => new LoopRecoveryService(db).recoverInterruptedRuns({ bootedAt: BOOT });

it('replays 17-10: an approved maker killed by the deploy restart is settled at boot so the lane frees', () => {
  for (const id of ['z1', 'z2', 'z3']) seed(id, { approval: 'approved' });
  const r = recover();
  expect(r.settledRuns).toBe(3);
  for (const id of ['z1', 'z2', 'z3']) {
    expect(row('loop_runs', `r-${id}`).status).toBe('interrupted');
    for (const lease of [`l-${id}`, `lc-${id}`]) {
      expect(row('worker_leases', lease).status).toBe('cancelled');
      expect(JSON.parse(row('worker_leases', lease).metadata).cancellation_reason).toBe('deploy_restart');
    }
    const goal = row('goals', `g-${id}`);
    expect(goal.status).toBe('failed');
    expect(JSON.parse(goal.metadata).awaiting_approval).toBeUndefined();
    expect(proposal(id)).toBe('infra_failed'); // requeueable (improvement-requeue REQUEUEABLE)
  }
  expect(recover().settledRuns).toBe(0); // idempotent
});

it('leaves a run that waits on a pending human approval untouched', () => {
  seed('w', { approval: 'pending', taskStatus: 'awaiting_approval' });
  expect(recover()).toMatchObject({ interruptedRuns: 0, settledRuns: 0 });
  expect(row('loop_runs', 'r-w').status).toBe('running');
  expect(row('worker_leases', 'l-w').status).toBe('prepared');
  expect(row('goals', 'g-w').status).toBe('blocked');
  expect(proposal('w')).toBe('executing');
});

it('leaves an approved run whose task finished alone (the daemon resumes it on its run)', () => {
  seed('done', { approval: 'approved', taskStatus: 'completed' });
  expect(recover()).toMatchObject({ interruptedRuns: 0, settledRuns: 0 });
  expect(row('loop_runs', 'r-done').status).toBe('running');
  expect(proposal('done')).toBe('executing');
});

it('leaves remote runs untouched: a remote gym run and a run with a remote maker sibling', () => {
  seed('gym', { approval: 'approved', runMeta: { gym: { remote_host: 'workstation', species: 'atomic' } } });
  seed('rm', { approval: 'approved', runtime: 'remote' });
  expect(recover().settledRuns).toBe(0);
  for (const id of ['gym', 'rm']) {
    expect(row('loop_runs', `r-${id}`).status).toBe('running');
    expect(row('worker_leases', `l-${id}`).status).toBe('prepared');
    expect(proposal(id)).toBe('executing');
  }
});

it('leaves a healthy run alone: one started after the boot is not settled', () => {
  seed('fresh', { approval: 'approved', at: '2026-10-17T00:40:00.000Z' });
  expect(recover().settledRuns).toBe(0);
  expect(row('worker_leases', 'l-fresh').status).toBe('prepared');
  expect(proposal('fresh')).toBe('executing');
});

it('does not settle a run whose maker lease was running (existing interruption only)', () => {
  seed('mid', { goalStatus: 'running', leaseStatus: 'running' });
  const r = recover();
  expect(r).toMatchObject({ interruptedRuns: 1, failedLeases: 1, settledRuns: 0 });
  expect(row('goals', 'g-mid').status).toBe('running');
  expect(proposal('mid')).toBe('executing');
});

it('stall watch: stuck_executing fires on the zombie shape, not on a pending approval wait', () => {
  const NOW = Date.parse('2026-10-17T15:00:00Z');
  seed('z', { approval: 'approved' });
  seed('w', { approval: 'pending', taskStatus: 'awaiting_approval' });
  const report = detectStallsWithHealth(db, NOW, {});
  expect(report.detectors.find((d) => d.name === 'stuck_executing')?.status).toBe('ok');
  const stall = report.stalls.find((s) => s.subsystem === 'stuck_executing');
  expect(stall?.detail).toContain('1 proposal(s)');
  expect(stall?.since).toBe(STARTED);
  // fresh activity (< 2 h): quiet
  db.prepare("UPDATE loop_runs SET updated_at = ? WHERE id = 'r-z'").run('2026-10-17T14:30:00.000Z');
  expect(detectStallsWithHealth(db, NOW, {}).stalls.find((s) => s.subsystem === 'stuck_executing')).toBeUndefined();
});
