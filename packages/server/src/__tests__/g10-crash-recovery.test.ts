import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { AgentAssuranceService } from '../services/agent-assurance-service';

let db: Database.Database;
let loops: LoopService;
let assurance: AgentAssuranceService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  loops = new LoopService(db, '/tmp/djimitflo-test-evidence');
  assurance = new AgentAssuranceService(db);
});

afterEach(() => { db?.close(); });

function insertRun(id: string, status: string, metadata: Record<string, unknown> = {}) {
  db.prepare(
    `INSERT INTO loop_runs (id, loop_name, mode, status, repository_path, findings_json, plan_json, gates_json, next_actions_json, metadata) VALUES (?, 'doc-drift-and-small-fix-loop', 'closed', ?, '/tmp/test-repo', '[]', '[]', '[]', '[]', ?)`,
  ).run(id, status, JSON.stringify(metadata));
}

function insertLease(id: string, runId: string, status: string, findingId: string | null, metadata: Record<string, unknown> = {}) {
  db.prepare(
    `INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, worktree_path, metadata) VALUES (?, ?, 'maker', 'mock', ?, ?, '/tmp/wt', ?)`,
  ).run(id, runId, status, findingId, JSON.stringify(metadata));
}

function insertFinding(runId: string, findingId: string) {
  const run = db.prepare('SELECT findings_json FROM loop_runs WHERE id = ?').get(runId) as { findings_json: string };
  const findings = JSON.parse(run.findings_json || '[]');
  findings.push({ id: findingId, title: `Finding ${findingId}`, severity: 'low', file_path: '/tmp/test.ts', metadata: {} });
  db.prepare('UPDATE loop_runs SET findings_json = ? WHERE id = ?').run(JSON.stringify(findings), runId);
}

describe('G10: Crash recovery with resume', () => {
  it('resumeInterruptedRun resumes an interrupted run from checkpoint', () => {
    insertRun('run-1', 'interrupted', { interrupted_reason: 'server_restart' });
    insertFinding('run-1', 'finding-a');
    insertFinding('run-1', 'finding-b');

    // Create a checkpoint.
    assurance.createCheckpoint({
      loop_run_id: 'run-1',
      label: 'before-maker',
      state_json: JSON.stringify({ phase: 'maker_running' }),
      gates_json: '[]',
      findings_json: '[]',
      leases_json: '[]',
      metadata: {},
    });

    // One lease completed, one failed (server_restart).
    insertLease('lease-1', 'run-1', 'completed', 'finding-a', {});
    insertLease('lease-2', 'run-1', 'failed', 'finding-b', { failed_reason: 'server_restart' });

    const result = loops.resumeInterruptedRun('run-1');

    expect(result.resumed).toBe(true);
    expect(result.boundedFail).toBe(false);
    expect(result.resumeAttempt).toBe(1);
    expect(result.requeuedFindings).toContain('finding-b');
    expect(result.skippedFindings).toContain('finding-a');

    const run = loops.getLoopRun('run-1');
    expect(run.status).toBe('running');
  });

  it('bounded-fails after maxResumeAttempts', () => {
    insertRun('run-2', 'interrupted', { resume_attempts: 3 });

    const result = loops.resumeInterruptedRun('run-2', 3);

    expect(result.resumed).toBe(false);
    expect(result.boundedFail).toBe(true);

    const run = loops.getLoopRun('run-2');
    expect(run.status).toBe('failed');
  });

  it('rejects resuming a non-interrupted run', () => {
    insertRun('run-3', 'running');
    expect(() => loops.resumeInterruptedRun('run-3')).toThrow('LOOP_RUN_NOT_INTERRUPTED');
  });

  it('resumeInterruptedRuns processes all interrupted runs', () => {
    insertRun('run-4a', 'interrupted', { interrupted_reason: 'server_restart' });
    insertRun('run-4b', 'interrupted', { interrupted_reason: 'budget_drain' });

    const result = loops.resumeInterruptedRuns();

    expect(result.resumed).toBe(2);
    expect(result.boundedFailed).toBe(0);
    expect(result.details.length).toBe(2);
  });

  it('does not re-queue a finding that was completed by another lease', () => {
    insertRun('run-5', 'interrupted', { interrupted_reason: 'server_restart' });
    insertFinding('run-5', 'finding-x');

    // Both a completed AND a failed lease for the same finding — the finding
    // was completed by another lease, so it should NOT be re-queued.
    insertLease('lease-5a', 'run-5', 'completed', 'finding-x', {});
    insertLease('lease-5b', 'run-5', 'failed', 'finding-x', { failed_reason: 'server_restart' });

    const result = loops.resumeInterruptedRun('run-5');

    expect(result.resumed).toBe(true);
    expect(result.requeuedFindings).not.toContain('finding-x');
    expect(result.skippedFindings).toContain('finding-x');
  });
});
