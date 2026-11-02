import { expect, it } from 'vitest';
import {
  inferFailureStage,
  cancellationReasonOf,
  cancelFailure,
} from '../services/lease-failure';

it('inferFailureStage returns cancel for cancelled status regardless of role', () => {
  expect(inferFailureStage('maker', 'cancelled', {})).toBe('cancel');
  expect(inferFailureStage('checker', 'cancelled', {})).toBe('cancel');
});

it('inferFailureStage returns checker for checker or security_checker role', () => {
  expect(inferFailureStage('checker', 'failed', {})).toBe('checker');
  expect(inferFailureStage('security_checker', 'failed', {})).toBe('checker');
});

it('inferFailureStage returns deps when deterministic_checks_failed mentions install', () => {
  const meta = { failure_reason: 'deterministic_checks_failed:install(npm ci),lint' };
  expect(inferFailureStage('maker', 'failed', meta)).toBe('deps');
});

it('inferFailureStage returns checks when deterministic_checks_failed has no install', () => {
  const meta = { failure_reason: 'deterministic_checks_failed:lint,type-check' };
  expect(inferFailureStage('maker', 'failed', meta)).toBe('checks');
});

it('inferFailureStage returns prepare for runtime contract / execution denied reasons', () => {
  expect(inferFailureStage('maker', 'failed', { runtime_contract_failed_at: true })).toBe('prepare');
  expect(inferFailureStage('maker', 'failed', { execution_denied_reason: 'no_capacity' })).toBe('prepare');
  expect(inferFailureStage('maker', 'failed', { runtime_fallback_refused: true })).toBe('prepare');
  expect(inferFailureStage('maker', 'failed', { failure_reason: 'MAKER_WORKTREE_NOT_FOUND: abc123' })).toBe('prepare');
  expect(inferFailureStage('maker', 'failed', { failure_reason: 'infra: subscription_auth failed' })).toBe('prepare');
});

it('inferFailureStage returns prepare for maker_execution_error before dispatch (no task_id, no completed_at)', () => {
  const meta = { failure_reason: 'maker_execution_error: boom' };
  expect(inferFailureStage('maker', 'failed', meta)).toBe('prepare');
});

it('inferFailureStage returns maker for maker_execution_error after dispatch', () => {
  const meta = { failure_reason: 'maker_execution_error: boom', execution_task_id: 42 };
  expect(inferFailureStage('maker', 'failed', meta)).toBe('maker');
});

it('inferFailureStage defaults to maker', () => {
  expect(inferFailureStage('maker', 'failed', {})).toBe('maker');
});

it('inferFailureStage reads failed_reason as alternative to failure_reason', () => {
  const meta = { failed_reason: 'deterministic_checks_failed:type-check' };
  expect(inferFailureStage('maker', 'failed', meta)).toBe('checks');
});

it('cancellationReasonOf returns the stated cancellation_reason', () => {
  expect(cancellationReasonOf({ cancellation_reason: 'operator_stop' })).toBe('operator_stop');
});

it('cancellationReasonOf returns operator_stop when stopped_by_runner is true', () => {
  expect(cancellationReasonOf({ stopped_by_runner: true })).toBe('operator_stop');
});

it('cancellationReasonOf returns superseded when superseded_by_maker_lease_id is set', () => {
  expect(cancellationReasonOf({ superseded_by_maker_lease_id: 'abc' })).toBe('superseded');
});

it('cancellationReasonOf returns the unspecified marker when no reason is present', () => {
  expect(cancellationReasonOf({})).toBe('unspecified: caller supplied no reason');
});

it('cancellationReasonOf prefers cancellation_reason over stopped_by_runner', () => {
  expect(cancellationReasonOf({ cancellation_reason: 'manual', stopped_by_runner: true })).toBe('manual');
});

it('cancelFailure builds a cancel-stage failure with the given reason', () => {
  const f = cancelFailure('operator_stop');
  expect(f.stage).toBe('cancel');
  expect(f.cancellation_reason).toBe('operator_stop');
  expect(f.exit_observed).toBe(false);
  expect(f.exit_code).toBe(null);
  expect(f.signal).toBe(null);
});

it('cancelFailure with empty reason still produces unspecified marker', () => {
  const f = cancelFailure('');
  expect(f.stage).toBe('cancel');
  expect(f.cancellation_reason).toBe('unspecified: caller supplied no reason');
});