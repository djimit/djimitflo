import { describe, expect, it } from 'vitest';
import { speciesKey } from '../services/runtime-bandit';
import type { Species } from '../services/evolve-selection';

describe('speciesKey', () => {
  it('returns runtime only when model is absent', () => {
    const s: Species = { runtime: 'opencode' };
    expect(speciesKey(s)).toBe('opencode');
  });

  it('returns runtime only when model is undefined', () => {
    const s: Species = { runtime: 'codex', model: undefined };
    expect(speciesKey(s)).toBe('codex');
  });

  it('joins runtime and model with @ when model is present', () => {
    const s: Species = { runtime: 'opencode', model: 'ollama/kimi-k2.6:cloud' };
    expect(speciesKey(s)).toBe('opencode@ollama/kimi-k2.6:cloud');
  });

  it('preserves runtime and model exactly, including special characters', () => {
    const s: Species = { runtime: 'claude', model: 'anthropic/claude-sonnet-4.5' };
    expect(speciesKey(s)).toBe('claude@anthropic/claude-sonnet-4.5');
  });

  it('produces the same key format used by chooseSpecies posterior', () => {
    const incumbent: Species = { runtime: 'opencode' };
    const challenger: Species = { runtime: 'opencode', model: 'ollama/kimi-k2.6:cloud' };
    expect(speciesKey(incumbent)).toBe('opencode');
    expect(speciesKey(challenger)).toBe('opencode@ollama/kimi-k2.6:cloud');
    expect(speciesKey(incumbent)).not.toBe(speciesKey(challenger));
  });

  it('treats empty-string model as absent (falsy), returning runtime only', () => {
    const s: Species = { runtime: 'hermes', model: '' };
    expect(speciesKey(s)).toBe('hermes');
  });
});