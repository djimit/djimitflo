import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopDaemon } from '../services/loop-daemon';
import { GoalService } from '../services/goal-service';
import { LoopService } from '../services/loop-service';
import { attributeOutcome, reviewerSubReason, type AttributionLease } from '../services/outcome-attribution';

/**
 * docs/research/di-001/REVIEWER_NO_VERDICT.md. Prod 09-13..10-14: in 9 runs the checker ended without a verdict and the
 * security checker was dispatched anyway, spending 3.97 M tokens on a run whose checker_verdict gate could no longer pass
 * (run 5b91e689: security 25114350 + its retry 8e7beb3a = 2.07 M; run 85bb0607: 249842e8 = 1.02 M). The same-input retry
 * is kept: of the two retries whose run was still open, one recovered a verdict for 74 k tokens (587d310f, verified).
 * LOOP_REVIEWER_STRATEGY=bounded (challenger, default off) skips only that security dispatch; the gates are unchanged.
 */
describe('LOOP_REVIEWER_STRATEGY=bounded: no security review once the checker has no verdict', () => {
  let db: Database.Database;
  const env = ['LOOP_DAEMON_AUTOMATED_CHECKER_ENABLED', 'LOOP_DAEMON_AUTOMATED_SECURITY_CHECKER_ENABLED', 'LOOP_REVIEWER_RETRY_ENABLED', 'LOOP_REVIEWER_STRATEGY'];
  const prev: Record<string, string | undefined> = {};
  let stub: Record<string, ReturnType<typeof vi.fn>>;
  let outcomes: Array<[string, Record<string, unknown>]>;

  // failure_reason strings as stored by executeChecker on the prod leases named
  const TIMED_OUT_5bf2c4ea = 'checker_runtime_failed:exit=1,timed_out=true: Error: OpenCode execution timed out after 300000ms';
  const BUDGET_d3f9e467 = 'checker_runtime_failed:exit=1,timed_out=false: Error: OpenCode token budget exceeded: 1041760 > 1000000 tokens (OPENCODE_MAX_RUN_TOKENS)';
  const SEC_BUDGET_bf6ea073 = 'security_checker_runtime_failed:exit=1,timed_out=false: Error: OpenCode token budget exceeded: 1041059 > 1000000 tokens (OPENCODE_MAX_RUN_TOKENS)';
  const noVerdict = (reason: string): [string, Record<string, unknown>] => ['failed', { verdict: 'insufficient_evidence', failure_reason: reason, exit_status: 1 }];

  const setLease = (id: string, status: string, patch: Record<string, unknown>) => {
    const row = db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(id) as { metadata: string };
    db.prepare('UPDATE worker_leases SET status = ?, metadata = ? WHERE id = ?').run(status, JSON.stringify({ ...JSON.parse(row.metadata), ...patch }), id);
  };

  beforeEach(() => {
    db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF');
    for (const k of env) prev[k] = process.env[k];
    // the prod reviewer configuration (10-14), plus the challenger flag per test
    Object.assign(process.env, { LOOP_DAEMON_AUTOMATED_CHECKER_ENABLED: 'true', LOOP_DAEMON_AUTOMATED_SECURITY_CHECKER_ENABLED: 'true', LOOP_REVIEWER_RETRY_ENABLED: 'true', LOOP_REVIEWER_STRATEGY: 'bounded' });
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
    const ins = db.prepare('INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, metadata, created_at) VALUES (?, \'run-1\', ?, ?, ?, \'f\', ?, \'2026-10-09T08:27:00Z\')');
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
  const leases = (role: string) => (db.prepare('SELECT id, status, metadata FROM worker_leases WHERE role = ? ORDER BY rowid').all(role) as Array<{ id: string; status: string; metadata: string }>)
    .map((l) => ({ id: l.id, role, status: l.status, metadata: JSON.parse(l.metadata) as AttributionLease['metadata'] }));
  const dispatched = () => stub.executeChecker.mock.calls.map((call) => (call[1] as { lease_id: string }).lease_id);
  const events = (type: string) => db.prepare('SELECT metadata FROM loop_events WHERE event_type = ?').all(type) as Array<{ metadata: string }>;

  it('run 5b91e689 replay: checker and its retry hit the token budget → the security checker is not dispatched', async () => {
    outcomes = [noVerdict(BUDGET_d3f9e467), noVerdict(BUDGET_d3f9e467)];
    await tick();
    const checkers = leases('checker');
    expect(checkers).toHaveLength(2); // the same-input retry is unchanged
    expect(dispatched()).toEqual(['checker-1', checkers[1].id]);
    const security = leases('security_checker');
    expect(security).toHaveLength(1);
    expect(security[0].status).toBe('prepared'); // never reviewed, never given a verdict
    expect(security[0].metadata.verdict).toBeUndefined();
    const skipped = events('security_checker_dispatch_skipped');
    expect(skipped).toHaveLength(1);
    expect(JSON.parse(skipped[0].metadata)).toMatchObject({ maker_lease_id: 'maker-1', checker_sub_reason: 'token_budget', strategy: 'bounded' });
    expect(stub.verifyLoopRun).toHaveBeenCalledTimes(1); // the gates still decide (and fail) the run
  });

  it('the missing verdict stays a reviewer_failure with its cause — never accepted, rejected or a maker loss', async () => {
    outcomes = [noVerdict(TIMED_OUT_5bf2c4ea), noVerdict(TIMED_OUT_5bf2c4ea)];
    await tick();
    const maker = { id: 'maker-1', role: 'maker', status: 'completed', metadata: { exit_status: 0, completed_at: '2026-10-09T08:30:00Z', changed_files: ['a.test.ts'] } };
    const a = attributeOutcome({ failed_gates: ['checker_verdict: no accepted verdict', 'security_checker_verdict: no accepted verdict'], maker, reviewers: [...leases('checker'), ...leases('security_checker')] });
    expect(a.outcome).toBe('reviewer_failure');
    expect(a.sub_reason).toBe('timeout');
    for (const l of [...leases('checker'), ...leases('security_checker')]) expect(['accepted', 'rejected', 'needs_revision']).not.toContain(l.metadata.verdict);
  });

  it('baseline (flag unset): the security checker is still dispatched after a checker without a verdict', async () => {
    delete process.env.LOOP_REVIEWER_STRATEGY;
    outcomes = [noVerdict(BUDGET_d3f9e467), noVerdict(BUDGET_d3f9e467)];
    await tick();
    expect(dispatched()).toEqual(['checker-1', leases('checker')[1].id, 'security-1']);
    expect(events('security_checker_dispatch_skipped')).toHaveLength(0);
  });

  it('run 587d310f replay: a recovered retry keeps the security review, and the security retry itself is unchanged', async () => {
    outcomes = [['completed', { verdict: 'accepted' }], noVerdict(SEC_BUDGET_bf6ea073), ['completed', { verdict: 'accepted' }]];
    await tick();
    const security = leases('security_checker');
    expect(security).toHaveLength(2);
    expect(security[1].metadata).toMatchObject({ retry_of: 'security-1', requires_security_review: true });
    expect(dispatched()).toEqual(['checker-1', 'security-1', security[1].id]);
    expect(events('security_checker_dispatch_skipped')).toHaveLength(0);
  });

  it('a checker that recovers on its retry → the security checker runs', async () => {
    outcomes = [noVerdict(TIMED_OUT_5bf2c4ea), ['completed', { verdict: 'accepted' }]];
    await tick();
    expect(dispatched()).toEqual(['checker-1', leases('checker')[1].id, 'security-1']);
  });

  it('a checker that said no is a verdict: the security checker still runs (its review is not weakened)', async () => {
    for (const verdict of ['rejected', 'needs_revision']) {
      stub.executeChecker.mockClear();
      db.prepare("UPDATE worker_leases SET status = 'prepared', metadata = json_remove(metadata, '$.verdict') WHERE id IN ('checker-1', 'security-1')").run();
      db.prepare("DELETE FROM worker_leases WHERE json_extract(metadata, '$.retry_of') IS NOT NULL").run();
      db.prepare("UPDATE goals SET status = 'decomposed'").run();
      outcomes = [['completed', { verdict, notes: 'breaks the API' }]];
      await tick();
      expect(dispatched()).toEqual(['checker-1', 'security-1']);
    }
  });

  it('no hidden fallback: a skip creates no lease and runs no other reviewer, runtime or model', async () => {
    const before = (db.prepare('SELECT COUNT(*) n FROM worker_leases').get() as { n: number }).n;
    outcomes = [noVerdict(BUDGET_d3f9e467), noVerdict(BUDGET_d3f9e467)];
    await tick();
    expect((db.prepare('SELECT COUNT(*) n FROM worker_leases').get() as { n: number }).n).toBe(before + 1); // only the checker's retry
    expect(stub.executeChecker).toHaveBeenCalledTimes(2);
    expect(stub.executeWorker).toHaveBeenCalledTimes(1); // the maker only
  });
});

/**
 * Prod 10-13 lease d32721a7 (security_checker, glm-5.2, the only post-#716 no-verdict lease): one step, exit 0, the text
 * part was a tool-call fragment (`</arg_key><arg_value>…</tool_call>`). extractCheckerVerdict stores insufficient_evidence
 * for both "the reviewer said insufficient_evidence" and "no verdict parsed", so #816 filed it as insufficient_evidence.
 * verdict_parsed (stored by executeChecker) separates the two; the stored verdict and the gates are unchanged.
 */
describe('reviewerSubReason: an unparsed verdict is not the reviewer saying insufficient_evidence', () => {
  const lease = (metadata: Record<string, unknown>): AttributionLease => ({ id: 'r', role: 'security_checker', status: 'completed', metadata: { verdict: 'insufficient_evidence', exit_status: 0, ...metadata } });
  it('verdict_parsed false → unparsed_verdict; true → insufficient_evidence; rows before the field → insufficient_evidence (as before)', () => {
    expect(reviewerSubReason(lease({ verdict_parsed: false }), false)).toBe('unparsed_verdict');
    expect(reviewerSubReason(lease({ verdict_parsed: true }), false)).toBe('insufficient_evidence');
    expect(reviewerSubReason(lease({}), false)).toBe('insufficient_evidence');
  });
});
