import { describe, expect, it } from 'vitest';
import { SwarmConcurrencyService } from '../services/swarm-concurrency-service';

describe('SwarmConcurrencyService — concurrency slots', () => {
  it('checkConcurrencySlot reports available with Infinity max when slot is unset', () => {
    const svc = new SwarmConcurrencyService();
    expect(svc.checkConcurrencySlot('adapter', 'low')).toEqual({ available: true, active: 0, max: Infinity });
  });

  it('setConcurrencySlot preserves existing active count', () => {
    const svc = new SwarmConcurrencyService();
    svc.setConcurrencySlot('adapter', 'low', 2);
    svc.acquireConcurrencySlot('adapter', 'low');
    svc.setConcurrencySlot('adapter', 'low', 5);
    expect(svc.checkConcurrencySlot('adapter', 'low')).toEqual({ available: true, active: 1, max: 5 });
  });

  it('acquireConcurrencySlot returns true and increments active when below max', () => {
    const svc = new SwarmConcurrencyService();
    svc.setConcurrencySlot('adapter', 'low', 2);
    expect(svc.acquireConcurrencySlot('adapter', 'low')).toBe(true);
    expect(svc.acquireConcurrencySlot('adapter', 'low')).toBe(true);
    expect(svc.checkConcurrencySlot('adapter', 'low')).toEqual({ available: false, active: 2, max: 2 });
  });

  it('acquireConcurrencySlot returns false when at max', () => {
    const svc = new SwarmConcurrencyService();
    svc.setConcurrencySlot('adapter', 'low', 1);
    expect(svc.acquireConcurrencySlot('adapter', 'low')).toBe(true);
    expect(svc.acquireConcurrencySlot('adapter', 'low')).toBe(false);
  });

  it('acquireConcurrencySlot returns true for unset slot (no cap)', () => {
    const svc = new SwarmConcurrencyService();
    expect(svc.acquireConcurrencySlot('adapter', 'low')).toBe(true);
  });

  it('releaseConcurrencySlot decrements active but not below zero', () => {
    const svc = new SwarmConcurrencyService();
    svc.setConcurrencySlot('adapter', 'low', 2);
    svc.acquireConcurrencySlot('adapter', 'low');
    svc.releaseConcurrencySlot('adapter', 'low');
    expect(svc.checkConcurrencySlot('adapter', 'low').active).toBe(0);
    svc.releaseConcurrencySlot('adapter', 'low');
    expect(svc.checkConcurrencySlot('adapter', 'low').active).toBe(0);
  });

  it('releaseConcurrencySlot is a no-op for unset slot', () => {
    const svc = new SwarmConcurrencyService();
    svc.releaseConcurrencySlot('adapter', 'low');
    expect(svc.checkConcurrencySlot('adapter', 'low')).toEqual({ available: true, active: 0, max: Infinity });
  });

  it('slots are keyed by adapter:riskClass independently', () => {
    const svc = new SwarmConcurrencyService();
    svc.setConcurrencySlot('a', 'low', 1);
    svc.setConcurrencySlot('b', 'low', 1);
    svc.acquireConcurrencySlot('a', 'low');
    expect(svc.acquireConcurrencySlot('a', 'low')).toBe(false);
    expect(svc.acquireConcurrencySlot('b', 'low')).toBe(true);
  });
});

describe('SwarmConcurrencyService — circuit breaker', () => {
  it('checkCircuitBreaker reports not tripped for unknown scope', () => {
    const svc = new SwarmConcurrencyService();
    expect(svc.checkCircuitBreaker('scope')).toEqual({ tripped: false, failures: 0, reason: null });
  });

  it('recordCircuitBreakerFailure increments failures and returns current count', () => {
    const svc = new SwarmConcurrencyService();
    expect(svc.recordCircuitBreakerFailure('scope')).toEqual({ tripped: false, failures: 1 });
    expect(svc.recordCircuitBreakerFailure('scope')).toEqual({ tripped: false, failures: 2 });
  });

  it('trips the breaker after threshold failures', () => {
    const svc = new SwarmConcurrencyService();
    svc.recordCircuitBreakerFailure('scope');
    svc.recordCircuitBreakerFailure('scope');
    const result = svc.recordCircuitBreakerFailure('scope');
    expect(result.tripped).toBe(true);
    expect(result.failures).toBe(3);
  });

  it('checkCircuitBreaker returns tripped reason when breaker is active', () => {
    const svc = new SwarmConcurrencyService();
    for (let i = 0; i < 3; i++) svc.recordCircuitBreakerFailure('scope');
    const result = svc.checkCircuitBreaker('scope');
    expect(result.tripped).toBe(true);
    expect(result.failures).toBe(3);
    expect(result.reason).toBe('circuit_breaker_tripped:scope:3_failures');
  });

  it('resetCircuitBreaker clears the scope state', () => {
    const svc = new SwarmConcurrencyService();
    for (let i = 0; i < 3; i++) svc.recordCircuitBreakerFailure('scope');
    svc.resetCircuitBreaker('scope');
    expect(svc.checkCircuitBreaker('scope')).toEqual({ tripped: false, failures: 0, reason: null });
  });

  it('resets the breaker after cooldown elapses', () => {
    const svc = new SwarmConcurrencyService();
    for (let i = 0; i < 3; i++) svc.recordCircuitBreakerFailure('scope');
    expect(svc.checkCircuitBreaker('scope').tripped).toBe(true);
    // Backdate lastFailureAt past the 60s cooldown.
    const state = (svc as unknown as { circuitBreakerState: Map<string, { lastFailureAt: string }> }).circuitBreakerState.get('scope');
    state.lastFailureAt = new Date(Date.now() - 61_000).toISOString();
    expect(svc.checkCircuitBreaker('scope')).toEqual({ tripped: false, failures: 0, reason: null });
  });

  it('stays tripped when cooldown has not elapsed', () => {
    const svc = new SwarmConcurrencyService();
    for (let i = 0; i < 3; i++) svc.recordCircuitBreakerFailure('scope');
    const result = svc.checkCircuitBreaker('scope');
    expect(result.tripped).toBe(true);
    expect(result.reason).not.toBeNull();
  });

  it('tracks scopes independently', () => {
    const svc = new SwarmConcurrencyService();
    for (let i = 0; i < 3; i++) svc.recordCircuitBreakerFailure('a');
    svc.recordCircuitBreakerFailure('b');
    expect(svc.checkCircuitBreaker('a').tripped).toBe(true);
    expect(svc.checkCircuitBreaker('b').tripped).toBe(false);
    expect(svc.checkCircuitBreaker('b').failures).toBe(1);
  });
});