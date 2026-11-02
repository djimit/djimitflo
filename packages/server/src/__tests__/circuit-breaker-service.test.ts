import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CircuitBreakerService } from '../services/circuit-breaker-service';

describe('CircuitBreakerService', () => {
  let breaker: CircuitBreakerService;

  beforeEach(() => {
    breaker = new CircuitBreakerService(3, 100, 2); // 3 failures, 100ms recovery, 2 successes
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts in CLOSED state', () => {
    expect(breaker.canExecute('claude')).toBe(true);
    expect(breaker.getState('claude')).toEqual({
      state: 'CLOSED',
      failures: 0,
      successes: 0,
      lastFailureAt: 0,
      openedAt: 0,
    });
  });

  it('opens after threshold failures', () => {
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    expect(breaker.canExecute('claude')).toBe(false);
    expect(breaker.getState('claude').state).toBe('OPEN');
    expect(breaker.getState('claude').failures).toBe(3);
  });

  it('does not open below threshold failures', () => {
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    expect(breaker.canExecute('claude')).toBe(true);
    expect(breaker.getState('claude').state).toBe('CLOSED');
  });

  it('transitions to HALF_OPEN after recovery timeout', async () => {
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    expect(breaker.canExecute('claude')).toBe(false);

    await new Promise((r) => setTimeout(r, 150));
    expect(breaker.canExecute('claude')).toBe(true); // HALF_OPEN
    expect(breaker.getState('claude').state).toBe('HALF_OPEN');
    expect(breaker.getState('claude').successes).toBe(0);
  });

  it('stays OPEN before recovery timeout elapses', async () => {
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    await new Promise((r) => setTimeout(r, 40));
    expect(breaker.canExecute('claude')).toBe(false);
    expect(breaker.getState('claude').state).toBe('OPEN');
  });

  it('closes after success threshold in HALF_OPEN and resets counters', async () => {
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');

    await new Promise((r) => setTimeout(r, 150));
    expect(breaker.canExecute('claude')).toBe(true); // triggers OPEN -> HALF_OPEN
    breaker.recordSuccess('claude');
    expect(breaker.getState('claude').state).toBe('HALF_OPEN'); // one success is not enough
    expect(breaker.getState('claude').successes).toBe(1);
    breaker.recordSuccess('claude');
    const closed = breaker.getState('claude');
    expect(closed.state).toBe('CLOSED');
    expect(closed.failures).toBe(0);
    expect(closed.successes).toBe(0);
    expect(breaker.canExecute('claude')).toBe(true); // CLOSED
  });

  it('reopens on failure in HALF_OPEN and zeroes successes', async () => {
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');

    await new Promise((r) => setTimeout(r, 150));
    expect(breaker.canExecute('claude')).toBe(true); // triggers OPEN -> HALF_OPEN
    breaker.recordSuccess('claude'); // successes = 1, still HALF_OPEN
    breaker.recordFailure('claude');
    expect(breaker.canExecute('claude')).toBe(false); // OPEN again
    expect(breaker.getState('claude').state).toBe('OPEN');
    expect(breaker.getState('claude').successes).toBe(0);
    // the early return in HALF_OPEN recordFailure must not touch the CLOSED
    // sliding-window branch, so failures stays at its pre-recovery value (3)
    expect(breaker.getState('claude').failures).toBe(3);
  });

  it('recordSuccess in CLOSED resets the failure counter', () => {
    breaker.recordFailure('claude');
    breaker.recordFailure('claude'); // failures = 2, one short of threshold
    breaker.recordSuccess('claude');
    expect(breaker.getState('claude').failures).toBe(0);
    // two more failures after the reset must not trip the breaker (2 < 3)
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    expect(breaker.canExecute('claude')).toBe(true);
    expect(breaker.getState('claude').state).toBe('CLOSED');
  });

  it('recordSuccess in CLOSED does not change state to HALF_OPEN or OPEN', () => {
    breaker.recordSuccess('claude');
    expect(breaker.getState('claude').state).toBe('CLOSED');
    expect(breaker.getState('claude').successes).toBe(0);
  });

  it('resets the failure count when failures fall outside the sliding window', () => {
    vi.useFakeTimers();
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    // advance past the 60s sliding window so the next failure resets the count
    vi.advanceTimersByTime(60_001);
    breaker.recordFailure('claude'); // failures reset to 0 then ++ -> 1, still below threshold
    expect(breaker.canExecute('claude')).toBe(true);
    expect(breaker.getState('claude').state).toBe('CLOSED');
    expect(breaker.getState('claude').failures).toBe(1);
  });

  it('does not reset the failure count inside the sliding window', () => {
    vi.useFakeTimers();
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    vi.advanceTimersByTime(59_999); // still inside the 60s window
    breaker.recordFailure('claude'); // failures -> 3, trips the breaker
    expect(breaker.canExecute('claude')).toBe(false);
    expect(breaker.getState('claude').state).toBe('OPEN');
  });

  it('tracks different executors independently', () => {
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    expect(breaker.canExecute('claude')).toBe(false);
    expect(breaker.canExecute('codex')).toBe(true);
    expect(breaker.getState('codex').state).toBe('CLOSED');
  });

  it('resets state', () => {
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    breaker.reset('claude');
    expect(breaker.canExecute('claude')).toBe(true);
    expect(breaker.getState('claude')).toEqual({
      state: 'CLOSED',
      failures: 0,
      successes: 0,
      lastFailureAt: 0,
      openedAt: 0,
    });
  });

  it('resetAll clears every executor', () => {
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    breaker.recordFailure('codex');
    breaker.resetAll();
    expect(breaker.canExecute('claude')).toBe(true);
    expect(breaker.canExecute('codex')).toBe(true);
    expect(breaker.getState('claude').failures).toBe(0);
    expect(breaker.getState('codex').failures).toBe(0);
  });

  it('HALF_OPEN allows execution while probing', async () => {
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    await new Promise((r) => setTimeout(r, 150));
    breaker.canExecute('claude'); // transitions to HALF_OPEN
    expect(breaker.canExecute('claude')).toBe(true); // still HALF_OPEN, still allows
    expect(breaker.getState('claude').state).toBe('HALF_OPEN');
  });
});