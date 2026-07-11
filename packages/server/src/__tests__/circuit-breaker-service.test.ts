import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreakerService } from '../services/circuit-breaker-service';

describe('CircuitBreakerService', () => {
  let breaker: CircuitBreakerService;

  beforeEach(() => {
    breaker = new CircuitBreakerService(3, 100, 2); // 3 failures, 100ms recovery, 2 successes
  });

  it('starts in CLOSED state', () => {
    expect(breaker.canExecute('claude')).toBe(true);
  });

  it('opens after threshold failures', () => {
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    expect(breaker.canExecute('claude')).toBe(false);
  });

  it('transitions to HALF_OPEN after recovery timeout', async () => {
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    expect(breaker.canExecute('claude')).toBe(false);

    await new Promise((r) => setTimeout(r, 150));
    expect(breaker.canExecute('claude')).toBe(true); // HALF_OPEN
  });

  it('closes after success threshold in HALF_OPEN', async () => {
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');

    await new Promise((r) => setTimeout(r, 150));
    breaker.recordSuccess('claude');
    breaker.recordSuccess('claude');
    expect(breaker.canExecute('claude')).toBe(true); // CLOSED
  });

  it('reopens on failure in HALF_OPEN', async () => {
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');

    await new Promise((r) => setTimeout(r, 150));
    breaker.recordFailure('claude');
    expect(breaker.canExecute('claude')).toBe(false); // OPEN again
  });

  it('tracks different executors independently', () => {
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    expect(breaker.canExecute('claude')).toBe(false);
    expect(breaker.canExecute('codex')).toBe(true);
  });

  it('resets state', () => {
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    breaker.reset('claude');
    expect(breaker.canExecute('claude')).toBe(true);
  });
});
