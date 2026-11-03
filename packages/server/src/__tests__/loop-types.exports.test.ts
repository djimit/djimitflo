import { describe, expect, it } from 'vitest';
import { gatePasses, allGatesPassed } from '../services/loop-types';
import type { LoopGate } from '../services/loop-types';

const gate = (name: string, status: LoopGate['status']): Pick<LoopGate, 'name' | 'status'> => ({ name, status });

describe('gatePasses', () => {
  it('returns true when status is pass', () => {
    expect(gatePasses(gate('any_gate', 'pass'))).toBe(true);
  });

  it('returns false when status is fail', () => {
    expect(gatePasses(gate('any_gate', 'fail'))).toBe(false);
  });

  it('returns false when status is unknown', () => {
    expect(gatePasses(gate('any_gate', 'unknown'))).toBe(false);
  });

  it('returns false for a skipped gate that is not the security_checker_verdict', () => {
    expect(gatePasses(gate('maker_verdict', 'skipped'))).toBe(false);
    expect(gatePasses(gate('checker_verdict', 'skipped'))).toBe(false);
  });

  it('returns true for the security_checker_verdict gate when skipped (low-risk run exemption)', () => {
    expect(gatePasses(gate('security_checker_verdict', 'skipped'))).toBe(true);
  });

  it('returns false for security_checker_verdict when status is fail or unknown', () => {
    expect(gatePasses(gate('security_checker_verdict', 'fail'))).toBe(false);
    expect(gatePasses(gate('security_checker_verdict', 'unknown'))).toBe(false);
  });
});

describe('allGatesPassed', () => {
  it('returns false when there are no gates (no gates is not a pass)', () => {
    expect(allGatesPassed([])).toBe(false);
  });

  it('returns true when every gate passes', () => {
    expect(allGatesPassed([
      gate('maker_verdict', 'pass'),
      gate('checker_verdict', 'pass'),
    ])).toBe(true);
  });

  it('returns true when the only gate is a skipped security_checker_verdict', () => {
    expect(allGatesPassed([gate('security_checker_verdict', 'skipped')])).toBe(true);
  });

  it('returns true mixing a pass gate with a skipped security_checker_verdict', () => {
    expect(allGatesPassed([
      gate('maker_verdict', 'pass'),
      gate('security_checker_verdict', 'skipped'),
    ])).toBe(true);
  });

  it('returns false when any gate fails', () => {
    expect(allGatesPassed([
      gate('maker_verdict', 'pass'),
      gate('checker_verdict', 'fail'),
    ])).toBe(false);
  });

  it('returns false when any gate is unknown', () => {
    expect(allGatesPassed([
      gate('maker_verdict', 'pass'),
      gate('checker_verdict', 'unknown'),
    ])).toBe(false);
  });

  it('returns false when a non-security gate is skipped', () => {
    expect(allGatesPassed([
      gate('maker_verdict', 'pass'),
      gate('governance_verdict', 'skipped'),
    ])).toBe(false);
  });

  it('treats the input array as read-only (does not mutate)', () => {
    const gates: ReadonlyArray<Pick<LoopGate, 'name' | 'status'>> = Object.freeze([
      gate('maker_verdict', 'pass'),
      gate('checker_verdict', 'pass'),
    ]);
    expect(() => allGatesPassed(gates)).not.toThrow();
    expect(allGatesPassed(gates)).toBe(true);
  });
});