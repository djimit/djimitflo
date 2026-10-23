import { describe, expect, it } from 'vitest';
import { sanitizeProdGates } from '../services/remote-gym-service';

describe('remote-gym-service exports — sanitizeProdGates', () => {
  it('returns undefined for null', () => {
    expect(sanitizeProdGates(null)).toBe(undefined);
  });

  it('returns undefined for non-object values', () => {
    expect(sanitizeProdGates('pass')).toBe(undefined);
    expect(sanitizeProdGates(42)).toBe(undefined);
    expect(sanitizeProdGates(true)).toBe(undefined);
  });

  it('returns undefined for arrays', () => {
    expect(sanitizeProdGates(['pass'])).toBe(undefined);
  });

  it('keeps entries with valid keys and pass/fail/skipped values', () => {
    expect(sanitizeProdGates({ lint: 'pass', 'type-check': 'fail', 'test:changed': 'skipped' })).toEqual({
      lint: 'pass',
      'type-check': 'fail',
      'test:changed': 'skipped',
    });
  });

  it('drops entries whose value is not a known gate status', () => {
    expect(sanitizeProdGates({ lint: 'pass', build: 'ok', test: 'error' })).toEqual({ lint: 'pass' });
  });

  it('drops entries with invalid keys (regex or too long)', () => {
    expect(sanitizeProdGates({ 'has space': 'pass', '': 'pass', ['x'.repeat(41)]: 'pass', good: 'fail' })).toEqual({ good: 'fail' });
  });

  it('coerces values to string before checking the status set', () => {
    // GATE_STATUS.has(String(v)) — String('pass') === 'pass'
    expect(sanitizeProdGates({ lint: 'pass' })).toEqual({ lint: 'pass' });
  });

  it('caps the output at 10 valid entries', () => {
    const input: Record<string, string> = {};
    for (let i = 0; i < 15; i++) input[`check${i}`] = 'pass';
    const out = sanitizeProdGates(input) as Record<string, string>;
    expect(Object.keys(out).length).toBe(10);
  });

  it('returns undefined when no entries survive filtering', () => {
    expect(sanitizeProdGates({ bad: 'ok' })).toBe(undefined);
    expect(sanitizeProdGates({})).toBe(undefined);
  });
});