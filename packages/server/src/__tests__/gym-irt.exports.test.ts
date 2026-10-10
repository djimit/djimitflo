import { describe, expect, it } from 'vitest';
import { respondentKey } from '../services/gym-irt';

describe('respondentKey', () => {
  it('joins species and genome with a pipe', () => {
    expect(respondentKey('atomic@llama-router', 'genome-42')).toBe('atomic@llama-router|genome-42');
  });

  it('defaults to baseline when genome is undefined', () => {
    expect(respondentKey('atomic@llama-router')).toBe('atomic@llama-router|baseline');
  });

  it('defaults to baseline when genome is null', () => {
    expect(respondentKey('atomic@llama-router', null)).toBe('atomic@llama-router|baseline');
  });

  it('defaults to baseline when genome is an empty string', () => {
    expect(respondentKey('atomic@llama-router', '')).toBe('atomic@llama-router|baseline');
  });

  it('preserves a falsy-but-non-empty genome is impossible (empty handled above)', () => {
    expect(respondentKey('species-x', '0')).toBe('species-x|0');
  });

  it('handles species containing a pipe character', () => {
    expect(respondentKey('a|b', 'g')).toBe('a|b|g');
  });

  it('handles special characters in species and genome', () => {
    expect(respondentKey('claude@router/v2', 'mut#1')).toBe('claude@router/v2|mut#1');
  });
});