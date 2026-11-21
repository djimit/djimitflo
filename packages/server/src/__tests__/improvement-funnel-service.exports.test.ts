import { describe, expect, it } from 'vitest';
import { regressedCause } from '../services/improvement-funnel-service';

/**
 * regressedCause (improvement-funnel-service.ts) is a pure helper that turns one
 * regressed proposal's newest loop run (its gates JSON and maker leases) into the
 * reason it ended regressed. It is exported but had no test naming it; this
 * test-only file covers every branch with literal inputs only — no DB, no network.
 */

const noMakers: Array<{ status: string | null; meta: string | null }> = [];

describe('regressedCause', () => {
  it('returns "rejected" when the checker verdict gate failed', () => {
    const gates = JSON.stringify([{ name: 'checker_verdict', status: 'fail' }]);
    expect(regressedCause(gates, noMakers)).toBe('rejected');
  });

  it('returns "rejected" when the security_checker_verdict gate failed', () => {
    const gates = JSON.stringify([{ name: 'security_checker_verdict', status: 'fail' }]);
    expect(regressedCause(gates, noMakers)).toBe('rejected');
  });

  it('returns "rejected" even when a maker also missed (checker takes priority)', () => {
    const gates = JSON.stringify([{ name: 'checker_verdict', status: 'fail' }, { name: 'deterministic_checks', status: 'fail' }]);
    const makers = [{ status: 'cancelled', meta: null }];
    expect(regressedCause(gates, makers)).toBe('rejected');
  });

  it('returns "unknown" when no gates failed', () => {
    const gates = JSON.stringify([{ name: 'checker_verdict', status: 'pass' }, { name: 'deterministic_checks', status: 'pass' }]);
    expect(regressedCause(gates, noMakers)).toBe('unknown');
  });

  it('returns "unknown" when gates JSON is null', () => {
    expect(regressedCause(null, noMakers)).toBe('unknown');
  });

  it('returns "unknown" when gates JSON is an empty array', () => {
    expect(regressedCause('[]', noMakers)).toBe('unknown');
  });

  it('returns "unknown" when gates JSON is malformed', () => {
    expect(regressedCause('not-json', noMakers)).toBe('unknown');
  });

  it('ignores gates whose status is not "fail"', () => {
    const gates = JSON.stringify([{ name: 'deterministic_checks', status: 'pass' }, { name: 'lint', status: 'warn' }]);
    expect(regressedCause(gates, noMakers)).toBe('unknown');
  });

  it('returns "token_budget" when a maker meta reports token_budget_hit', () => {
    const gates = JSON.stringify([{ name: 'maker', status: 'fail' }]);
    const makers = [{ status: 'failed', meta: JSON.stringify({ failure: { token_budget_hit: true } }) }];
    expect(regressedCause(gates, makers)).toBe('token_budget');
  });

  it('returns "token_budget" when a maker failure_reason mentions the token budget', () => {
    const gates = JSON.stringify([{ name: 'maker', status: 'fail' }]);
    const makers = [{ status: 'failed', meta: JSON.stringify({ failure_reason: 'Token budget exceeded at 30k' }) }];
    expect(regressedCause(gates, makers)).toBe('token_budget');
  });

  it('returns "timeout" when a maker meta reports failure.timed_out', () => {
    const gates = JSON.stringify([{ name: 'maker', status: 'fail' }]);
    const makers = [{ status: 'failed', meta: JSON.stringify({ failure: { timed_out: true } }) }];
    expect(regressedCause(gates, makers)).toBe('timeout');
  });

  it('returns "timeout" when a maker top-level runtime_timed_out is true', () => {
    const gates = JSON.stringify([{ name: 'maker', status: 'fail' }]);
    const makers = [{ status: 'failed', meta: JSON.stringify({ runtime_timed_out: true }) }];
    expect(regressedCause(gates, makers)).toBe('timeout');
  });

  it('returns "timeout" when a maker failure_reason matches the timed_out pattern', () => {
    const gates = JSON.stringify([{ name: 'maker', status: 'fail' }]);
    const makers = [{ status: 'failed', meta: JSON.stringify({ failure_reason: 'step timed_out after 600s' }) }];
    expect(regressedCause(gates, makers)).toBe('timeout');
  });

  it('prefers token_budget over timeout when both are present', () => {
    const gates = JSON.stringify([{ name: 'maker', status: 'fail' }]);
    const makers = [
      { status: 'failed', meta: JSON.stringify({ failure: { timed_out: true } }) },
      { status: 'failed', meta: JSON.stringify({ failure: { token_budget_hit: true } }) },
    ];
    expect(regressedCause(gates, makers)).toBe('token_budget');
  });

  it('returns "cancelled" when a maker lease was cancelled and no budget/timeout signal', () => {
    const gates = JSON.stringify([{ name: 'maker', status: 'fail' }]);
    const makers = [{ status: 'cancelled', meta: null }];
    expect(regressedCause(gates, makers)).toBe('cancelled');
  });

  it('returns "check_failed" when a maker failure_reason starts with deterministic_checks_failed', () => {
    const gates = JSON.stringify([{ name: 'maker', status: 'fail' }]);
    const makers = [{ status: 'failed', meta: JSON.stringify({ failure_reason: 'deterministic_checks_failed: lint' }) }];
    expect(regressedCause(gates, makers)).toBe('check_failed');
  });

  it('returns "other" when a non-checker gate failed but no maker reason matches', () => {
    const gates = JSON.stringify([{ name: 'maker', status: 'fail' }]);
    const makers = [{ status: 'failed', meta: JSON.stringify({ failure_reason: 'something else' }) }];
    expect(regressedCause(gates, makers)).toBe('other');
  });

  it('returns "other" when a gate failed and there are no makers', () => {
    const gates = JSON.stringify([{ name: 'maker', status: 'fail' }]);
    expect(regressedCause(gates, noMakers)).toBe('other');
  });

  it('treats a maker with malformed meta as an empty object (no reason matches)', () => {
    const gates = JSON.stringify([{ name: 'maker', status: 'fail' }]);
    const makers = [{ status: 'failed', meta: 'not-json' }];
    expect(regressedCause(gates, makers)).toBe('other');
  });
});
