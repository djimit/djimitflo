import { describe, it, expect, beforeEach } from 'vitest';
import { FallbackChainService } from '../services/fallback-chain-service';
import { CircuitBreakerService } from '../services/circuit-breaker-service';

describe('FallbackChainService', () => {
  let chain: FallbackChainService;
  let breaker: CircuitBreakerService;

  beforeEach(() => {
    chain = new FallbackChainService();
    breaker = new CircuitBreakerService(3, 100, 2);
  });

  it('returns correct chain for each mode', () => {
    expect(chain.getChain('fast')).toEqual(['opencode', 'gemini', 'claude']);
    expect(chain.getChain('standard')).toEqual(['claude', 'codex', 'gemini']);
    expect(chain.getChain('controlled')).toEqual(['claude', 'codex']);
    expect(chain.getChain('restricted')).toEqual(['claude']);
  });

  it('returns first available executor', () => {
    const result = chain.getFirstAvailable('standard', breaker);
    expect(result).toBe('claude');
  });

  it('skips circuit-open executors', () => {
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    const result = chain.getFirstAvailable('standard', breaker);
    expect(result).toBe('codex');
  });

  it('returns null when all circuits open', () => {
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    breaker.recordFailure('codex');
    breaker.recordFailure('codex');
    breaker.recordFailure('codex');
    breaker.recordFailure('gemini');
    breaker.recordFailure('gemini');
    breaker.recordFailure('gemini');
    const result = chain.getFirstAvailable('standard', breaker);
    expect(result).toBeNull();
  });

  it('gets next available after current', () => {
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    const result = chain.getNextAvailable('claude', 'standard', breaker);
    expect(result).toBe('codex');
  });

  it('allows custom chains', () => {
    chain.setChain('fast', ['gemini', 'claude']);
    expect(chain.getChain('fast')).toEqual(['gemini', 'claude']);
  });
});
