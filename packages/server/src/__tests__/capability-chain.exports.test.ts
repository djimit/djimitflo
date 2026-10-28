import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, chmodSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { statPath, isAnomaly, type CapabilityVerdict } from '../services/capability-chain';

// statPath classifies a path by fs.statSync + read-access probe:
//   directory → 'dir', file → 'file', ENOENT/ENOTDIR → 'missing', anything else → 'unreadable'.
describe('statPath', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cap-chain-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("returns 'dir' for an existing directory", () => {
    const d = join(root, 'sub');
    mkdirSync(d);
    expect(statPath(d)).toBe('dir');
  });

  it("returns 'file' for an existing regular file", () => {
    const f = join(root, 'a.txt');
    writeFileSync(f, 'x');
    expect(statPath(f)).toBe('file');
  });

  it("returns 'missing' for a path that does not exist (ENOENT)", () => {
    expect(statPath(join(root, 'nope'))).toBe('missing');
  });

  it("returns 'missing' for a path under a non-directory (ENOTDIR)", () => {
    const f = join(root, 'leaf');
    writeFileSync(f, 'x');
    expect(statPath(join(f, 'child'))).toBe('missing');
  });

  it("returns 'unreadable' when stat succeeds but read access is denied (EACCES)", () => {
    const f = join(root, 'secret');
    writeFileSync(f, 'x');
    chmodSync(f, 0o000);
    try {
      // root bypasses POSIX permission checks; skip in that case so the suite stays green in CI.
      const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
      if (uid === 0) { expect(true).toBe(true); return; }
      expect(statPath(f)).toBe('unreadable');
    } finally {
      chmodSync(f, 0o644);
    }
  });
});

// isAnomaly is the triage predicate: only actionable degraded states count as anomalies.
// HEALTHY and IDLE_EXPECTED are normal operation; UNKNOWN is insufficient evidence, not a fault.
describe('isAnomaly', () => {
  const v = (state: CapabilityVerdict['state']): CapabilityVerdict =>
    ({
      component: 'x',
      state,
      link: 'OUTCOME_PERSISTED',
      chain: { CONFIGURED: 'ok', ENABLED: 'ok', DEPENDENCIES_READY: 'ok', SCHEDULED: 'ok', EXECUTED: 'ok', OUTCOME_PERSISTED: 'ok' },
      facts: [],
      window: { ms: 0, since: '' },
      remediation: '',
    }) as CapabilityVerdict;

  it('returns true for STALLED', () => { expect(isAnomaly(v('STALLED'))).toBe(true); });
  it('returns true for BLOCKED', () => { expect(isAnomaly(v('BLOCKED'))).toBe(true); });
  it('returns true for MISCONFIGURED', () => { expect(isAnomaly(v('MISCONFIGURED'))).toBe(true); });

  it('returns false for HEALTHY', () => { expect(isAnomaly(v('HEALTHY'))).toBe(false); });
  it('returns false for IDLE_EXPECTED', () => { expect(isAnomaly(v('IDLE_EXPECTED'))).toBe(false); });
  it('returns false for DISABLED_BY_POLICY', () => { expect(isAnomaly(v('DISABLED_BY_POLICY'))).toBe(false); });
  it('returns false for UNCONFIGURED', () => { expect(isAnomaly(v('UNCONFIGURED'))).toBe(false); });
  it('returns false for UNKNOWN (insufficient evidence is not a fault)', () => { expect(isAnomaly(v('UNKNOWN'))).toBe(false); });
});