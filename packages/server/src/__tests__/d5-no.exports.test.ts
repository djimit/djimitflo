import { describe, expect, it } from 'vitest';
import { caseOutcome, D5NO_DEADLINE_DAYS, D5NO_MAX_RISK } from '../services/d5-no';

describe('d5-no exports (caseOutcome, D5NO_MAX_RISK, D5NO_DEADLINE_DAYS)', () => {
  it('exposes the frozen protocol risk threshold and deadline window', () => {
    expect(D5NO_MAX_RISK).toBe(0.05);
    expect(D5NO_DEADLINE_DAYS).toBe(90);
  });

  it('classifies a verified status as a false rejection (conservative: any verified wins)', () => {
    expect(caseOutcome(['verified'])).toBe('false_rejection');
    expect(caseOutcome(['regressed', 'verified'])).toBe('false_rejection');
    expect(caseOutcome(['verified', 'proposed'])).toBe('false_rejection');
  });

  it('classifies in-flight statuses as pending (before settling on censored/correct)', () => {
    for (const s of ['proposed', 'scheduled', 'executing', 'evaluating', 'applied']) {
      expect(caseOutcome([s])).toBe('pending');
    }
    expect(caseOutcome(['regressed', 'scheduled'])).toBe('pending');
  });

  it('classifies an all-infra-failed cluster as censored', () => {
    expect(caseOutcome(['infra_failed'])).toBe('censored');
    expect(caseOutcome(['infra_failed', 'infra_failed'])).toBe('censored');
  });

  it('does not call a mixed infra/real-outcome cluster censored (infra_failed is not exhaustive)', () => {
    expect(caseOutcome(['infra_failed', 'regressed'])).toBe('correct_rejection');
    expect(caseOutcome(['infra_failed', 'no_change'])).toBe('correct_rejection');
  });

  it('classifies settled rejection outcomes as correct rejection', () => {
    for (const s of ['rejected', 'no_change', 'regressed', 'needs_more_evidence', 'needs_grounding', 'archived']) {
      expect(caseOutcome([s])).toBe('correct_rejection');
    }
    expect(caseOutcome(['rejected', 'no_change', 'needs_grounding'])).toBe('correct_rejection');
  });

  it('treats an empty status list as a correct rejection (no pending, no infra, no verified)', () => {
    expect(caseOutcome([])).toBe('correct_rejection');
  });

  it('prefers false rejection over pending when both appear (verified short-circuits)', () => {
    expect(caseOutcome(['proposed', 'verified'])).toBe('false_rejection');
  });
});