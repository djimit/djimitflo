import { describe, expect, it } from 'vitest';
import {
  artifactDigest,
  digestMatches,
  planContent,
  safeRelPath,
  type PlanDraft,
} from '../services/plan-artifact';

/**
 * Exports of services/plan-artifact.ts that had no test naming them:
 * digestMatches verifies a payload's stored digest equals its recomputed digest;
 * safeRelPath is the repository-relative path guard used across plan validation;
 * planContent rebuilds only the content fields of a validated PlanDraft.
 * Test-only; no production code is changed.
 */

describe('digestMatches', () => {
  it('returns true when the digest field equals the recomputed digest', () => {
    const payload = { a: 1, b: ['x', 'y'] } as unknown as Record<string, unknown>;
    const digest = artifactDigest(payload);
    expect(digestMatches({ ...payload, digest })).toBe(true);
  });

  it('returns false when the digest field is wrong', () => {
    const payload = { a: 1 } as unknown as Record<string, unknown>;
    expect(digestMatches({ ...payload, digest: 'deadbeef' })).toBe(false);
  });

  it('returns false when the digest field is missing or non-string', () => {
    expect(digestMatches({ a: 1 })).toBe(false);
    expect(digestMatches({ a: 1, digest: 42 })).toBe(false);
  });

  it('ignores the digest key when recomputing so re-digesting is stable', () => {
    const payload = { a: 1 } as unknown as Record<string, unknown>;
    const digest = artifactDigest(payload);
    // Adding the digest field does not change the recomputed digest.
    expect(artifactDigest({ ...payload, digest })).toBe(digest);
    expect(digestMatches({ ...payload, digest })).toBe(true);
  });
});

describe('safeRelPath', () => {
  it('accepts a plain repository-relative path', () => {
    expect(safeRelPath('packages/server/src/index.ts')).toBe(true);
    expect(safeRelPath('a/b/c.txt')).toBe(true);
  });

  it('rejects empty, absolute, and backslash paths', () => {
    expect(safeRelPath('')).toBe(false);
    expect(safeRelPath('/etc/passwd')).toBe(false);
    expect(safeRelPath('a\\b')).toBe(false);
  });

  it('rejects traversal and trailing-slash segments', () => {
    expect(safeRelPath('../x')).toBe(false);
    expect(safeRelPath('a/../b')).toBe(false);
    expect(safeRelPath('a/./b')).toBe(false);
    expect(safeRelPath('a//b')).toBe(false);
    expect(safeRelPath('a/')).toBe(false);
  });

  it('rejects non-strings and overlong paths', () => {
    expect(safeRelPath(123)).toBe(false);
    expect(safeRelPath(null)).toBe(false);
    expect(safeRelPath(undefined)).toBe(false);
    expect(safeRelPath('a/'.repeat(200))).toBe(false);
  });

  it('rejects control characters', () => {
    expect(safeRelPath('a\nb')).toBe(false);
    expect(safeRelPath('a\rb')).toBe(false);
    expect(safeRelPath('a\0b')).toBe(false);
  });
});

describe('planContent', () => {
  function sampleDraft(): PlanDraft {
    return {
      sources: [{ path: 'a.ts', symbol: 'foo' }, { path: 'b.ts' }],
      decisions: ['d1', 'd2'],
      assumptions: ['a1'],
      uncertainties: ['u1'],
      open_questions: ['q1'],
      findings_review: [{ claim_id: 'c1', status: 'confirmed', note: 'ok' }],
      steps: [
        { id: 's1', title: 't1', depends_on: [], scope: ['a.ts'], expected_artifacts: ['x'], verification: ['lint'] },
        { id: 's2', title: 't2', depends_on: ['s1'], scope: ['b.ts'], expected_artifacts: ['y'], verification: ['test:changed'] },
      ],
      stop_conditions: ['stop1'],
      recovery: 'recover',
    };
  }

  it('rebuilds a deep copy with the same content fields', () => {
    const d = sampleDraft();
    const out = planContent(d);
    expect(out).toEqual(d);
  });

  it('returns a new object graph (no shared array references with the input)', () => {
    const d = sampleDraft();
    const out = planContent(d);
    expect(out).not.toBe(d);
    expect(out.steps).not.toBe(d.steps);
    expect(out.steps[0]).not.toBe(d.steps[0]);
    expect(out.steps[0].scope).not.toBe(d.steps[0].scope);
    expect(out.decisions).not.toBe(d.decisions);
    expect(out.sources).not.toBe(d.sources);
    expect(out.findings_review).not.toBe(d.findings_review);
  });

  it('normalizes source refs by dropping an undefined symbol key', () => {
    const d = sampleDraft();
    const out = planContent(d);
    expect(Object.prototype.hasOwnProperty.call(out.sources[1], 'symbol')).toBe(false);
    expect(out.sources[0]).toEqual({ path: 'a.ts', symbol: 'foo' });
  });

  it('mutations of the result do not leak back into the input', () => {
    const d = sampleDraft();
    const out = planContent(d);
    out.decisions.push('d3');
    out.steps[0].scope.push('z.ts');
    expect(d.decisions).toEqual(['d1', 'd2']);
    expect(d.steps[0].scope).toEqual(['a.ts']);
  });

  it('copies findings_review member by member', () => {
    const d = sampleDraft();
    const out = planContent(d);
    expect(out.findings_review[0]).toEqual({ claim_id: 'c1', status: 'confirmed', note: 'ok' });
    expect(out.findings_review[0]).not.toBe(d.findings_review[0]);
  });
});
