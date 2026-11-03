import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopDaemon, reviewerRetryable } from '../services/loop-daemon';
import { GoalService } from '../services/goal-service';
import { LoopService } from '../services/loop-service';

/**
 * Prod 2026-10-08: since #687, 5/5 regressed proposals lacked a reviewer verdict — the reviewer's runtime gave out
 * ('checker_runtime_failed:exit=1,timed_out=true', 'security_checker_runtime_failed: ... token budget exceeded'), the maker was fine.
 * LOOP_REVIEWER_RETRY_ENABLED gives such a reviewer ONE fresh lease for the same maker; a real rejection is never retried.
 */
describe('reviewer retry after a runtime timeout / token budget', () => {
  let db: Database.Database;
  const env = ['LOOP_DAEMON_AUTOMATED_CHECKER_ENABLED', 'LOOP_DAEMON_AUTOMATED_SECURITY_CHECKER_ENABLED', 'LOOP_REVIEWER_RETRY_ENABLED'];
  const prev: Record<string, string | undefined> = {};
  let stub: Record<string, ReturnType<typeof vi.fn>>;
  /** what each executeChecker call does to the lease it ran: [status, metadata patch] */
  let outcomes: Array<[string, Record<string, unknown>]>;

  const TIMED_OUT = 'checker_runtime_failed:exit=1,timed_out=true: ';
  const setLease = (id: string, status: string, patch: Record<string, unknown>) => {
    const row = db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(id) as { metadata: string };
    db.prepare('UPDATE worker_leases SET status = ?, metadata = ? WHERE id = ?').run(status, JSON.stringify({ ...JSON.parse(row.metadata), ...patch }), id);
  };

  beforeEach(() => {
    db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF');
    for (const k of env) prev[k] = process.env[k];
    Object.assign(process.env, { LOOP_DAEMON_AUTOMATED_CHECKER_ENABLED: 'true', LOOP_REVIEWER_RETRY_ENABLED: 'true' });
    delete process.env.LOOP_DAEMON_AUTOMATED_SECURITY_CHECKER_ENABLED;
    outcomes = [];
    stub = {
      startDocDriftAndSmallFixLoop: vi.fn(() => ({ id: 'run-1', findings: [{ id: 'f', type: 't', severity: 'info', file: 'x', message: 'x', evidence: 'x', suggested_fix: 'x' }] })),
      continueLoopRun: vi.fn(() => ({ leases: [{ id: 'maker-1', role: 'maker', status: 'prepared', runtime: 'opencode' }] })),
      executeWorker: vi.fn(async () => ({})),
      runDeterministicChecks: vi.fn(() => ({ run: { status: 'verifying' }, lease: {}, checks: [] })),
      retryLoopRun: vi.fn(),
      executeChecker: vi.fn(async (_run: string, input: { lease_id: string }) => {
        const [status, patch] = outcomes.shift() ?? ['completed', { verdict: 'accepted' }];
        setLease(input.lease_id, status, patch);
        return {};
      }),
      verifyLoopRun: vi.fn(() => ({ gates: [] })),
      pruneOrphanedWorktrees: vi.fn(),
    };
    const goal = new GoalService(db).createGoal({ objective: 'Fix a small doc drift issue', acceptance_criteria: ['Tests pass'], risk_class: 'low', metadata: {} });
    db.prepare("UPDATE goals SET status = 'decomposed' WHERE id = ?").run(goal.id);
    const ins = db.prepare('INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, metadata, created_at) VALUES (?, \'run-1\', ?, ?, ?, \'f\', ?, \'2026-10-08T10:00:00Z\')');
    ins.run('maker-1', 'maker', 'opencode', 'completed', '{}');
    ins.run('checker-1', 'checker', 'manual', 'prepared', JSON.stringify({ maker_lease_id: 'maker-1', requires_independent_review: true }));
    ins.run('security-1', 'security_checker', 'manual', 'prepared', JSON.stringify({ maker_lease_id: 'maker-1', requires_security_review: true }));
  });
  afterEach(() => {
    db.close();
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  const tick = async () => {
    const daemon = new LoopDaemon(db, stub as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
    await daemon.tick(); await new Promise((resolve) => setImmediate(resolve)); daemon.stop();
  };
  const reviewers = (role: string) => db.prepare('SELECT id, status, metadata FROM worker_leases WHERE role = ? ORDER BY rowid').all(role) as Array<{ id: string; status: string; metadata: string }>;
  const leaseIdsDispatched = () => stub.executeChecker.mock.calls.map((call) => (call[1] as { lease_id: string }).lease_id);

  it('a timed-out checker gets exactly one fresh lease for the same maker, reviewed before the gates', async () => {
    outcomes = [['failed', { verdict: 'insufficient_evidence', failure_reason: TIMED_OUT }]];
    await tick();
    const checkers = reviewers('checker');
    expect(checkers).toHaveLength(2);
    const retry = JSON.parse(checkers[1].metadata) as Record<string, unknown>;
    expect(retry).toMatchObject({ maker_lease_id: 'maker-1', retry_of: 'checker-1', requires_independent_review: true });
    expect(leaseIdsDispatched()).toEqual(['checker-1', checkers[1].id]);
    expect(checkers[1].status).toBe('completed');
    expect(stub.verifyLoopRun.mock.invocationCallOrder[0]).toBeGreaterThan(stub.executeChecker.mock.invocationCallOrder[1]);
  });

  it('a reviewer that returned a negative verdict is a real rejection: no retry', async () => {
    outcomes = [['completed', { verdict: 'rejected', notes: 'breaks the API' }]];
    await tick();
    expect(reviewers('checker')).toHaveLength(1);
    expect(leaseIdsDispatched()).toEqual(['checker-1']);
  });

  it('two runtime failures: no third lease, the run is verified (and fails) as before', async () => {
    outcomes = [['failed', { verdict: 'insufficient_evidence', failure_reason: TIMED_OUT }], ['failed', { verdict: 'insufficient_evidence', failure_reason: TIMED_OUT }]];
    await tick();
    expect(reviewers('checker')).toHaveLength(2);
    expect(stub.executeChecker).toHaveBeenCalledTimes(2);
    expect(stub.verifyLoopRun).toHaveBeenCalledTimes(1);
  });

  it('a security reviewer that hit the token budget is retried too (the security verdict is still required)', async () => {
    process.env.LOOP_DAEMON_AUTOMATED_SECURITY_CHECKER_ENABLED = 'true';
    outcomes = [['completed', { verdict: 'accepted' }],
      ['failed', { verdict: 'insufficient_evidence', failure_reason: 'security_checker_runtime_failed:exit=1,timed_out=false: Error: OpenCode token budget exceeded: 710000 > 600000 tokens (OPENCODE_MAX_RUN_TOKENS)' }]];
    await tick();
    const security = reviewers('security_checker');
    expect(security).toHaveLength(2);
    expect(JSON.parse(security[1].metadata)).toMatchObject({ maker_lease_id: 'maker-1', retry_of: 'security-1', requires_security_review: true });
    expect(leaseIdsDispatched()).toEqual(['checker-1', 'security-1', security[1].id]);
  });

  it('off by default: a timed-out reviewer is not retried', async () => {
    delete process.env.LOOP_REVIEWER_RETRY_ENABLED;
    outcomes = [['failed', { verdict: 'insufficient_evidence', failure_reason: TIMED_OUT }]];
    await tick();
    expect(reviewers('checker')).toHaveLength(1);
  });

  it('only runtime timeouts and token budgets are retryable', () => {
    expect(reviewerRetryable('checker', 'failed', TIMED_OUT)).toBe(true);
    expect(reviewerRetryable('checker', 'failed', 'checker_runtime_failed:exit=1,timed_out=false: crash')).toBe(false);
    expect(reviewerRetryable('checker', 'failed', 'runtime_contract_unavailable_or_drifted')).toBe(false);
    expect(reviewerRetryable('checker', 'completed', TIMED_OUT)).toBe(false);
    expect(reviewerRetryable('security_checker', 'failed', TIMED_OUT)).toBe(false); // another role's reason
  });
});
