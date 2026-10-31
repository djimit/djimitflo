import { describe, it, expect, beforeEach } from 'vitest';
import { FallbackChainService, ExecutionMode } from '../services/fallback-chain-service';
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

  it('falls back to standard chain for unknown mode', () => {
    const result = chain.getChain('nonexistent' as ExecutionMode);
    expect(result).toEqual(['claude', 'codex', 'gemini']);
  });

  it('constructor accepts custom chains and preserves defaults for others', () => {
    const custom = new FallbackChainService({ fast: ['gemini'], controlled: ['codex'] });
    expect(custom.getChain('fast')).toEqual(['gemini']);
    expect(custom.getChain('controlled')).toEqual(['codex']);
    // Unspecified modes keep their defaults
    expect(custom.getChain('standard')).toEqual(['claude', 'codex', 'gemini']);
    expect(custom.getChain('restricted')).toEqual(['claude']);
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

  it('getFirstAvailable skips excluded executors even when they are available', () => {
    // claude is first in standard chain and fully available, but excluded
    const result = chain.getFirstAvailable('standard', breaker, ['claude']);
    expect(result).toBe('codex');
  });

  it('getFirstAvailable skips multiple excluded executors', () => {
    const result = chain.getFirstAvailable('standard', breaker, ['claude', 'codex']);
    expect(result).toBe('gemini');
  });

  it('getFirstAvailable returns null when all remaining are excluded or open', () => {
    // restricted chain is just [claude]; excluding it leaves nothing
    const result = chain.getFirstAvailable('restricted', breaker, ['claude']);
    expect(result).toBeNull();
  });

  it('getFirstAvailable returns null for empty chain', () => {
    chain.setChain('fast', []);
    const result = chain.getFirstAvailable('fast', breaker);
    expect(result).toBeNull();
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

  it('getNextAvailable skips intermediate circuit-open executors', () => {
    // standard: [claude, codex, gemini]; claude is current, codex is open → gemini
    breaker.recordFailure('codex');
    breaker.recordFailure('codex');
    breaker.recordFailure('codex');
    const result = chain.getNextAvailable('claude', 'standard', breaker);
    expect(result).toBe('gemini');
  });

  it('getNextAvailable returns null when current is last in chain', () => {
    // gemini is the last element of standard chain; nothing after it
    const result = chain.getNextAvailable('gemini', 'standard', breaker);
    expect(result).toBeNull();
  });

  it('getNextAvailable returns null when all remaining are circuit-open', () => {
    // claude is current; both codex and gemini are open
    breaker.recordFailure('codex');
    breaker.recordFailure('codex');
    breaker.recordFailure('codex');
    breaker.recordFailure('gemini');
    breaker.recordFailure('gemini');
    breaker.recordFailure('gemini');
    const result = chain.getNextAvailable('claude', 'standard', breaker);
    expect(result).toBeNull();
  });

  it('getNextAvailable falls back to full scan when current not in chain', () => {
    // opencode is NOT in standard [claude, codex, gemini]
    // Should find first available excluding opencode → claude
    const result = chain.getNextAvailable('opencode', 'standard', breaker);
    expect(result).toBe('claude');
  });

  it('getNextAvailable with unknown current skips circuit-open executors', () => {
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    breaker.recordFailure('claude');
    // opencode not in chain; claude open → codex
    const result = chain.getNextAvailable('opencode', 'standard', breaker);
    expect(result).toBe('codex');
  });

  it('setChain replaces the chain for a mode', () => {
    chain.setChain('restricted', ['codex', 'gemini']);
    expect(chain.getChain('restricted')).toEqual(['codex', 'gemini']);
    const result = chain.getFirstAvailable('restricted', breaker);
    expect(result).toBe('codex');
  });
});
