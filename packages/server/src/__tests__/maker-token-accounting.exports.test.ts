import { describe, it, expect } from 'vitest';
import { safeTokenAccounting, computeTokenAccounting, type MakerTokenAccounting } from '../services/maker-token-accounting';

describe('safeTokenAccounting', () => {
  it('returns the accounting produced by compute when it does not throw', () => {
    const expected = computeTokenAccounting({
      runtime: 'opencode',
      stdout: JSON.stringify({ type: 'step_finish', part: { tokens: { input: 10, output: 5, total: 15 } } }),
      leaseMetadata: { model: 'openai/gpt-4o' },
      durationMs: 42,
    });
    const result = safeTokenAccounting(() => expected, 'opencode');
    expect(result).toBe(expected);
  });

  it('catches a thrown Error and returns an unavailable accounting with the error message', () => {
    const result = safeTokenAccounting(() => { throw new Error('boom'); }, 'codex');
    expect(result.measurement_source).toBe('unavailable');
    expect(result.completeness).toBe('none');
    expect(result.reason).toBe('accounting_error: boom');
    expect(result.runtime).toBe('codex');
    expect(result.version).toBe(1);
  });

  it('preserves the runtime string in the fallback even when compute throws', () => {
    const result = safeTokenAccounting(() => { throw new Error('x'); }, 'claude');
    expect(result.runtime).toBe('claude');
  });

  it('sets all token fields and cost fields to null in the fallback', () => {
    const result = safeTokenAccounting(() => { throw new Error('fail'); }, 'opencode');
    for (const f of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'total_tokens'] as const) {
      expect(result[f]).toBeNull();
    }
    expect(result.estimated_cost_usd).toBeNull();
    expect(result.cost_completeness).toBeNull();
    expect(result.cost_reason).toBe('accounting failed');
    expect(result.price_input_per_mtok).toBeNull();
    expect(result.price_source).toBeNull();
    expect(result.model_id).toBeNull();
    expect(result.model_source).toBeNull();
    expect(result.provider).toBeNull();
    expect(result.duration_ms).toBeNull();
    expect(result.retry_count).toBe(0);
  });

  it('truncates a very long error message to 200 characters (after the prefix)', () => {
    const longMsg = 'x'.repeat(500);
    const result = safeTokenAccounting(() => { throw new Error(longMsg); }, 'opencode');
    expect(result.reason).toBe(`accounting_error: ${'x'.repeat(200)}`);
    expect(result.reason!.length).toBe('accounting_error: '.length + 200);
  });

  it('handles non-Error thrown values by stringifying them', () => {
    const result = safeTokenAccounting(() => { throw 'string error'; }, 'codex');
    expect(result.reason).toBe('accounting_error: string error');
    expect(result.measurement_source).toBe('unavailable');
  });

  it('handles a thrown object without a message property', () => {
    const result = safeTokenAccounting(() => { throw { code: 42 }; }, 'claude');
    expect(result.reason).toBe('accounting_error: [object Object]');
  });

  it('returns whatever compute yields, including a manually constructed accounting', () => {
    const manual: MakerTokenAccounting = {
      version: 1, runtime: 'mock', model_id: null, model_source: null, provider: null,
      input_tokens: 1, output_tokens: 2, cache_read_tokens: null, cache_write_tokens: null,
      reasoning_tokens: null, total_tokens: 3, duration_ms: 10, retry_count: 0,
      estimated_cost_usd: null, cost_completeness: null, cost_reason: null,
      price_input_per_mtok: null, price_output_per_mtok: null, price_cache_read_per_mtok: null,
      price_cache_write_per_mtok: null, price_source: null, price_version: null,
      measurement_source: 'unavailable', completeness: 'none', reason: 'manual',
    };
    expect(safeTokenAccounting(() => manual, 'mock')).toBe(manual);
  });

  it('does not swallow a returned value — only catches throws', () => {
    let called = false;
    const result = safeTokenAccounting(() => { called = true; return computeTokenAccounting({ runtime: 'atomic', stdout: '', leaseMetadata: {}, durationMs: null }); }, 'atomic');
    expect(called).toBe(true);
    expect(result.runtime).toBe('atomic');
  });
});