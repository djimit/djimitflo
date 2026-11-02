import { expect, it, describe } from 'vitest';
import { parseCpuStatUsageUsec } from '../services/resource-scheduler';

// parseCpuStatUsageUsec extracts the usage_usec field from a cgroup v2 cpu.stat
// file body. Absent or unparseable → null (never a fabricated number).
describe('parseCpuStatUsageUsec', () => {
  it('returns the usage_usec value from a single-line cpu.stat body', () => {
    expect(parseCpuStatUsageUsec('usage_usec 123456789\n')).toBe(123_456_789);
  });

  it('returns the usage_usec value when it appears among other stat fields', () => {
    const stat = 'usage_usec 5000\nuser_usec 1\nsystem_usec 1\nnr_periods 3\nnr_throttled 0\n';
    expect(parseCpuStatUsageUsec(stat)).toBe(5000);
  });

  it('matches the first usage_usec occurrence (multiline ^…$ anchored per line)', () => {
    const stat = 'usage_usec 7\nusage_usec 9\n';
    expect(parseCpuStatUsageUsec(stat)).toBe(7);
  });

  it('tolerates trailing whitespace after the number', () => {
    expect(parseCpuStatUsageUsec('usage_usec 42   \n')).toBe(42);
  });

  it('returns null when usage_usec is absent', () => {
    expect(parseCpuStatUsageUsec('user_usec 1\nsystem_usec 1\n')).toBeNull();
  });

  it('returns null when usage_usec has no digits (non-numeric value)', () => {
    expect(parseCpuStatUsageUsec('usage_usec abc\n')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseCpuStatUsageUsec('')).toBeNull();
  });

  it('returns null for unstructured / garbage input', () => {
    expect(parseCpuStatUsageUsec('not a stat file')).toBeNull();
  });

  it('does not match usage_usec embedded in a longer token on the same line', () => {
    expect(parseCpuStatUsageUsec('xusage_usec 5\n')).toBeNull();
  });
});