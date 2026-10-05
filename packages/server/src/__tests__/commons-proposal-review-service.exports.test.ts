import { afterEach, describe, expect, it } from 'vitest';
import { commonsReviewEnabled, isInfrastructureFailure } from '../services/commons-proposal-review-service';

describe('commonsReviewEnabled', () => {
  const prev = process.env.COMMONS_PROPOSAL_REVIEW_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.COMMONS_PROPOSAL_REVIEW_ENABLED;
    else process.env.COMMONS_PROPOSAL_REVIEW_ENABLED = prev;
  });

  it('returns false when COMMONS_PROPOSAL_REVIEW_ENABLED is unset', () => {
    delete process.env.COMMONS_PROPOSAL_REVIEW_ENABLED;
    expect(commonsReviewEnabled()).toBe(false);
  });

  it('returns false when COMMONS_PROPOSAL_REVIEW_ENABLED is not "true"', () => {
    process.env.COMMONS_PROPOSAL_REVIEW_ENABLED = 'false';
    expect(commonsReviewEnabled()).toBe(false);
  });

  it('returns true when COMMONS_PROPOSAL_REVIEW_ENABLED is "true"', () => {
    process.env.COMMONS_PROPOSAL_REVIEW_ENABLED = 'true';
    expect(commonsReviewEnabled()).toBe(true);
  });
});

describe('isInfrastructureFailure', () => {
  it.each([
    'WORKTREE_CREATE_FAILED: foo',
    'fatal: cannot lock ref refs/heads/x',
    'RUNTIME_UNAVAILABLE',
    'requested runtime is unavailable',
    'ECONNREFUSED 127.0.0.1:8080',
    'ETIMEDOUT',
    'ENOSPC: no space left on device',
    'approval expired',
  ])('returns true for infra failure: %s', (detail) => {
    expect(isInfrastructureFailure(detail)).toBe(true);
  });

  it.each([
    'test failure: expected 1 got 2',
    'syntax error in module.ts',
    '',
    'normal runtime error',
  ])('returns false for non-infra detail: %s', (detail) => {
    expect(isInfrastructureFailure(detail)).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isInfrastructureFailure('worktree_create_failed')).toBe(true);
    expect(isInfrastructureFailure('Approval Expired')).toBe(true);
  });
});