import { describe, expect, it, vi, afterEach } from 'vitest';
import { hourBucket } from '../services/policy-violations';

afterEach(() => { vi.useRealTimers(); });

describe('hourBucket', () => {
  it('returns YYYY-MM-DDTHH (13 chars) for a known timestamp', () => {
    expect(hourBucket(Date.parse('2026-10-09T12:34:56.789Z'))).toBe('2026-10-09T12');
  });

  it('produces the same bucket for every minute within the same hour', () => {
    const base = Date.parse('2026-10-09T12:00:00Z');
    for (let m = 0; m < 60; m++) {
      expect(hourBucket(base + m * 60_000)).toBe('2026-10-09T12');
    }
  });

  it('produces different buckets for adjacent hours', () => {
    const t = Date.parse('2026-10-09T12:59:59.999Z');
    expect(hourBucket(t)).toBe('2026-10-09T12');
    expect(hourBucket(t + 1)).toBe('2026-10-09T13');
  });

  it('rolls over the day boundary at hour 23 -> 00', () => {
    const t = Date.parse('2026-10-09T23:59:59.999Z');
    expect(hourBucket(t)).toBe('2026-10-09T23');
    expect(hourBucket(t + 1)).toBe('2026-10-10T00');
  });

  it('returns the epoch hour for timestamp 0', () => {
    expect(hourBucket(0)).toBe('1970-01-01T00');
  });

  it('uses Date.now() when called with no argument', () => {
    const fixed = Date.parse('2026-01-15T08:30:00Z');
    vi.useFakeTimers(); vi.setSystemTime(fixed);
    expect(hourBucket()).toBe('2026-01-15T08');
  });

  it('always returns a 13-character string', () => {
    const samples = [0, 1, -1, Date.parse('2026-10-09T12:00:00Z'), Date.now()];
    for (const s of samples) {
      expect(hourBucket(s)).toHaveLength(13);
      expect(hourBucket(s)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}$/);
    }
  });

  it('is deterministic: same input always yields same output', () => {
    const t = Date.parse('2025-06-15T07:00:00Z');
    expect(hourBucket(t)).toBe(hourBucket(t));
  });
});