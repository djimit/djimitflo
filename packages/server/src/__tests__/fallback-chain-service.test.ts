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

  it('falls back to the standard chain for an unknown mode', () => {
    expect(chain.getChain('unknown' as never)).toEqual(chain.getChain('standard'));
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

  it('honours the exclude list and skips excluded executors', () => {
    expect(chain.getFirstAvailable('standard', breaker, ['claude'])).toBe('codex');
    expect(chain.getFirstAvailable('standard', breaker, ['claude', 'codex'])).toBe('gemini');
  });

  it('returns null when every chain member is excluded', () => {
    expect(
      chain.getFirstAvailable('standard', breaker, ['claude', 'codex', 'gemini']),
    ).toBeNull();
  });

  it('returns null for an empty custom chain', () => {
    chain.setChain('fast', []);
    expect(chain.getFirstAvailable('fast', breaker)).toBeNull();
  });

  it('gets next available after current', () => {
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    const result = chain.getNextAvailable('claude', 'standard', breaker);
    expect(result).toBe('codex');
  });

  it('returns the next available executor when current is still healthy', () => {
    expect(chain.getNextAvailable('claude', 'standard', breaker)).toBe('codex');
  });

  it('returns the last executor when current is the second-to-last', () => {
    expect(chain.getNextAvailable('codex', 'standard', breaker)).toBe('gemini');
  });

  it('returns null when current is the last executor in the chain', () => {
    expect(chain.getNextAvailable('gemini', 'standard', breaker)).toBeNull();
  });

  it('skips open circuits while advancing to the next available', () => {
    breaker.recordFailure('codex');
    breaker.recordFailure('codex');
    breaker.recordFailure('codex');
    expect(chain.getNextAvailable('claude', 'standard', breaker)).toBe('gemini');
  });

  it('returns null when every executor after current is open', () => {
    breaker.recordFailure('codex');
    breaker.recordFailure('codex');
    breaker.recordFailure('codex');
    breaker.recordFailure('gemini');
    breaker.recordFailure('gemini');
    breaker.recordFailure('gemini');
    expect(chain.getNextAvailable('claude', 'standard', breaker)).toBeNull();
  });

  it('walks the whole chain when current is not part of it', () => {
    expect(chain.getNextAvailable('hermes', 'standard', breaker)).toBe('claude');
  });

  it('returns null when current is not in the chain and all circuits are open', () => {
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    breaker.recordFailure('codex');
    breaker.recordFailure('codex');
    breaker.recordFailure('codex');
    breaker.recordFailure('gemini');
    breaker.recordFailure('gemini');
    breaker.recordFailure('gemini');
    expect(chain.getNextAvailable('hermes', 'standard', breaker)).toBeNull();
  });

  it('allows custom chains', () => {
    chain.setChain('fast', ['gemini', 'claude']);
    expect(chain.getChain('fast')).toEqual(['gemini', 'claude']);
  });

  it('constructor merges custom chains over the defaults', () => {
    const custom = new FallbackChainService({ fast: ['gemini', 'claude'] });
    expect(custom.getChain('fast')).toEqual(['gemini', 'claude']);
    expect(custom.getChain('standard')).toEqual(['claude', 'codex', 'gemini']);
    expect(custom.getChain('restricted')).toEqual(['claude']);
  });

  it('constructor does not mutate the default chains for other instances', () => {
    const custom = new FallbackChainService({ controlled: ['codex'] });
    expect(custom.getChain('controlled')).toEqual(['codex']);
    expect(chain.getChain('controlled')).toEqual(['claude', 'codex']);
  });
});
