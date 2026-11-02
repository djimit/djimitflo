import { describe, expect, it } from 'vitest';
import {
  DREAM_EXPOSURE_WINDOW_MS,
  DEFAULT_HOLDOUT_SIZE,
  HOLDOUT_SIZE_MAX,
  HOLDOUT_SIZE_MIN,
  exclusionReason,
  resolveHoldoutSize,
} from '../services/holdout-exposure';
import type { HoldoutExclusions } from '../services/holdout-exposure';

const empty = (): HoldoutExclusions => ({
  frozen: new Set(), tg: new Set(), trialAttempted: new Set(),
  exposedCommits: new Set(), exposedSources: new Set(), exposedRuns: new Set(), dreamGenomes: 0,
});

describe('holdout-exposure exports (exclusionReason, resolveHoldoutSize, constants)', () => {
  it('exposes the frozen exposure window and size bounds', () => {
    expect(DREAM_EXPOSURE_WINDOW_MS).toBe(86_400_000);
    expect(DEFAULT_HOLDOUT_SIZE).toBe(20);
    expect(HOLDOUT_SIZE_MIN).toBe(10);
    expect(HOLDOUT_SIZE_MAX).toBe(200);
  });

  describe('exclusionReason', () => {
    it('returns null when nothing matches', () => {
      const ex = empty();
      expect(exclusionReason(ex, { commit: 'abc123' })).toBeNull();
    });

    it('flags a commit already frozen in a holdout epoch', () => {
      const ex = empty(); ex.frozen.add('frozen1');
      expect(exclusionReason(ex, { commit: 'frozen1' })).toBe('already frozen in a holdout epoch');
    });

    it('flags a TG-001 task key', () => {
      const ex = empty(); ex.tg.add('tgkey');
      expect(exclusionReason(ex, { commit: 'tgkey' })).toBe('TG-001 task key');
    });

    it('flags a commit attempted in a genome trial', () => {
      const ex = empty(); ex.trialAttempted.add('trial1');
      expect(exclusionReason(ex, { commit: 'trial1' })).toBe('attempted in a genome trial');
    });

    it('flags a dream-exposed commit', () => {
      const ex = empty(); ex.exposedCommits.add('dexp');
      expect(exclusionReason(ex, { commit: 'dexp' })).toBe('dream-exposed commit');
    });

    it('flags a dream-exposed source file via source field', () => {
      const ex = empty(); ex.exposedSources.add('src/a.ts');
      expect(exclusionReason(ex, { commit: 'x', source: 'src/a.ts' })).toBe('dream-exposed source file src/a.ts');
    });

    it('flags a dream-exposed source file via target field', () => {
      const ex = empty(); ex.exposedSources.add('src/b.ts');
      expect(exclusionReason(ex, { commit: 'x', target: 'src/b.ts' })).toBe('dream-exposed source file src/b.ts');
    });

    it('flags derived-from when base prefix-matches an exposed commit (commit starts with base)', () => {
      const ex = empty(); ex.exposedCommits.add('abc1234567890');
      expect(exclusionReason(ex, { commit: 'other', base: 'abc1234' })).toBe('derived from dream-exposed commit abc1234');
    });

    it('flags derived-from when base prefix-matches an exposed commit (base starts with commit)', () => {
      const ex = empty(); ex.exposedCommits.add('abcdefg');
      expect(exclusionReason(ex, { commit: 'other', base: 'abcdefghij' })).toBe('derived from dream-exposed commit abcdefghij');
    });

    it('does not flag derived-from for short commits (< 7 chars)', () => {
      const ex = empty(); ex.exposedCommits.add('ab');
      expect(exclusionReason(ex, { commit: 'x', base: 'abcdefg' })).toBeNull();
    });

    it('flags a derived run id in the exposed runs set', () => {
      const ex = empty(); ex.exposedRuns.add('run-42');
      expect(exclusionReason(ex, { commit: 'x', run_id: 'run-42' })).toBe('derived from dream-exposed run run-42');
    });

    it('prioritises frozen over tg over trialAttempted over exposedCommits', () => {
      const ex = empty();
      ex.frozen.add('c'); ex.tg.add('c'); ex.trialAttempted.add('c'); ex.exposedCommits.add('c');
      expect(exclusionReason(ex, { commit: 'c' })).toBe('already frozen in a holdout epoch');
      ex.frozen.delete('c');
      expect(exclusionReason(ex, { commit: 'c' })).toBe('TG-001 task key');
      ex.tg.delete('c');
      expect(exclusionReason(ex, { commit: 'c' })).toBe('attempted in a genome trial');
      ex.trialAttempted.delete('c');
      expect(exclusionReason(ex, { commit: 'c' })).toBe('dream-exposed commit');
    });
  });

  describe('resolveHoldoutSize', () => {
    it('returns default 20 when neither env nor manifest is set', () => {
      expect(resolveHoldoutSize({})).toEqual({ ok: true, size: 20, source: 'default' });
    });

    it('reads from env when only HOLDOUT_SIZE is set', () => {
      expect(resolveHoldoutSize({ HOLDOUT_SIZE: '50' })).toEqual({ ok: true, size: 50, source: 'env' });
    });

    it('treats empty-string env as unset and falls back to default', () => {
      expect(resolveHoldoutSize({ HOLDOUT_SIZE: '' })).toEqual({ ok: true, size: 20, source: 'default' });
    });

    it('reads from manifest when only manifestSize is set', () => {
      expect(resolveHoldoutSize({}, 30)).toEqual({ ok: true, size: 30, source: 'manifest' });
    });

    it('prefers manifest over env when both are the same value', () => {
      expect(resolveHoldoutSize({ HOLDOUT_SIZE: '40' }, 40)).toEqual({ ok: true, size: 40, source: 'manifest' });
    });

    it('errors when env and manifest conflict', () => {
      const r = resolveHoldoutSize({ HOLDOUT_SIZE: '40' }, 50);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('conflicts');
    });

    it('rejects non-integer values', () => {
      expect(resolveHoldoutSize({ HOLDOUT_SIZE: 'abc' }).ok).toBe(false);
      expect(resolveHoldoutSize({}, 1.5).ok).toBe(false);
    });

    it('rejects values below MIN or above MAX', () => {
      expect(resolveHoldoutSize({ HOLDOUT_SIZE: '5' }).ok).toBe(false);
      expect(resolveHoldoutSize({ HOLDOUT_SIZE: '999' }).ok).toBe(false);
      expect(resolveHoldoutSize({}, 5).ok).toBe(false);
      expect(resolveHoldoutSize({}, 999).ok).toBe(false);
    });

    it('accepts boundary values MIN and MAX', () => {
      expect(resolveHoldoutSize({ HOLDOUT_SIZE: String(HOLDOUT_SIZE_MIN) })).toEqual({ ok: true, size: 10, source: 'env' });
      expect(resolveHoldoutSize({}, HOLDOUT_SIZE_MAX)).toEqual({ ok: true, size: 200, source: 'manifest' });
    });
  });
});
