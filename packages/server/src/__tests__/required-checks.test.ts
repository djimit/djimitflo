import { describe, expect, it } from 'vitest';
import { requiredChecksOf, newestRuns, requiredRun } from '../services/required-checks';
import type { CheckRun, RequiredCheck } from '../services/required-checks';

const run = (id: number, name: string, app: number | null = null, completed_at: string | null = null): CheckRun => ({
  id, name, status: 'completed', conclusion: 'SUCCESS', completed_at, app: app == null ? null : { id: app },
});

// requiredChecksOf translates a `required_status_checks` block into the canonical required check list.
// `checks` entries carry their producer app_id (>=0); a legacy `contexts` entry is any-source (app_id null).
describe('requiredChecksOf', () => {
  it('returns an empty list for null / undefined / empty input', () => {
    expect(requiredChecksOf(null)).toEqual([]);
    expect(requiredChecksOf(undefined)).toEqual([]);
    expect(requiredChecksOf({})).toEqual([]);
    expect(requiredChecksOf({ checks: [], contexts: [] })).toEqual([]);
  });

  it('maps a checks entry with a non-negative app_id to that producer', () => {
    expect(requiredChecksOf({ checks: [{ context: 'ci', app_id: 15368 }] })).toEqual<RequiredCheck[]>([
      { context: 'ci', app_id: 15368 },
    ]);
  });

  it('treats app_id -1 (GitHub Actions "any source" sentinel) as any-source (null)', () => {
    expect(requiredChecksOf({ checks: [{ context: 'sbom', app_id: -1 }] })).toEqual<RequiredCheck[]>([
      { context: 'sbom', app_id: null },
    ]);
  });

  it('treats an absent app_id as any-source (null)', () => {
    expect(requiredChecksOf({ checks: [{ context: 'lint' }] })).toEqual<RequiredCheck[]>([
      { context: 'lint', app_id: null },
    ]);
  });

  it('maps a legacy contexts entry to any-source', () => {
    expect(requiredChecksOf({ contexts: ['ci', 'lint'] })).toEqual<RequiredCheck[]>([
      { context: 'ci', app_id: null },
      { context: 'lint', app_id: null },
    ]);
  });

  it('lets a checks entry take precedence over a same-named contexts entry (producer identity wins)', () => {
    const out = requiredChecksOf({ checks: [{ context: 'ci', app_id: 15368 }], contexts: ['ci'] });
    expect(out).toEqual<RequiredCheck[]>([{ context: 'ci', app_id: 15368 }]);
  });

  it('merges checks and contexts, keeping insertion order (checks first, then new contexts)', () => {
    const out = requiredChecksOf({
      checks: [{ context: 'a', app_id: 1 }, { context: 'b', app_id: 2 }],
      contexts: ['a', 'c'],
    });
    expect(out).toEqual<RequiredCheck[]>([
      { context: 'a', app_id: 1 },
      { context: 'b', app_id: 2 },
      { context: 'c', app_id: null },
    ]);
  });

  it('skips checks entries whose context is an empty string or absent', () => {
    const checks = [{ context: '', app_id: 1 }, { app_id: 2 }] as Array<{ context?: string; app_id?: number | null }>;
    expect(requiredChecksOf({ checks })).toEqual<RequiredCheck[]>([]);
  });

  it('skips empty-string contexts entries', () => {
    expect(requiredChecksOf({ contexts: ['', 'ci'] })).toEqual<RequiredCheck[]>([{ context: 'ci', app_id: null }]);
  });
});

// newestRuns keeps the newest run per (producer app id, name): a rerun replaces the run it re-ran,
// and another app's run for the same name never hides it.
describe('newestRuns', () => {
  it('returns an empty list for no runs', () => {
    expect(newestRuns([])).toEqual([]);
  });

  it('returns a single run unchanged', () => {
    const r = run(1, 'ci');
    expect(newestRuns([r])).toEqual([r]);
  });

  it('keeps the higher-id rerun when the same app re-runs the same check', () => {
    const old = run(1, 'ci', 15368, '2026-10-25T10:00:00Z');
    const fresh = run(2, 'ci', 15368, '2026-10-25T11:00:00Z');
    expect(newestRuns([old, fresh])).toEqual([fresh]);
    expect(newestRuns([fresh, old])).toEqual([fresh]);
  });

  it('does not let another app hide a different app run for the same name', () => {
    const a = run(1, 'sbom', 15368, '2026-10-25T10:00:00Z');
    const b = run(2, 'sbom', 9, '2026-10-25T11:00:00Z');
    const out = newestRuns([a, b]);
    expect(out).toHaveLength(2);
    expect(out).toContainEqual(a);
    expect(out).toContainEqual(b);
  });

  it('falls back to completed_at ordering when ids are equal or missing', () => {
    const earlier = { name: 'ci', completed_at: '2026-10-25T09:00:00Z', app: { id: 1 } } as CheckRun;
    const later = { name: 'ci', completed_at: '2026-10-25T12:00:00Z', app: { id: 1 } } as CheckRun;
    expect(newestRuns([earlier, later])).toEqual([later]);
    expect(newestRuns([later, earlier])).toEqual([later]);
  });

  it('treats a missing id as 0 for ordering', () => {
    const withId = run(5, 'ci', 1);
    const noId = { name: 'ci', completed_at: null, app: { id: 1 } } as CheckRun;
    expect(newestRuns([noId, withId])).toEqual([withId]);
  });
});

// requiredRun is the newest run of a required check from its required producer;
// undefined when that producer has not reported it.
describe('requiredRun', () => {
  it('returns undefined when no run matches the required context', () => {
    expect(requiredRun([run(1, 'other')], { context: 'ci', app_id: null })).toBeUndefined();
  });

  it('returns the run for an any-source required check', () => {
    const r = run(1, 'ci', 15368);
    expect(requiredRun([r], { context: 'ci', app_id: null })).toBe(r);
  });

  it('returns the run from the required producer only', () => {
    const mine = run(1, 'sbom', 15368);
    const theirs = run(2, 'sbom', 9);
    expect(requiredRun([mine, theirs], { context: 'sbom', app_id: 15368 })).toBe(mine);
    expect(requiredRun([mine, theirs], { context: 'sbom', app_id: 9 })).toBe(theirs);
  });

  it('returns undefined when the required producer has not reported the context', () => {
    const theirs = run(2, 'sbom', 9);
    expect(requiredRun([theirs], { context: 'sbom', app_id: 15368 })).toBeUndefined();
  });

  it('returns the newest run when the required producer re-ran the check', () => {
    const old = run(1, 'ci', 15368, '2026-10-25T10:00:00Z');
    const fresh = run(2, 'ci', 15368, '2026-10-25T11:00:00Z');
    expect(requiredRun([old, fresh], { context: 'ci', app_id: 15368 })).toBe(fresh);
  });

  it('ignores runs whose name does not match the required context', () => {
    const other = run(1, 'lint', 15368);
    const match = run(2, 'ci', 15368);
    expect(requiredRun([other, match], { context: 'ci', app_id: 15368 })).toBe(match);
  });
});