import { describe, expect, it, vi } from 'vitest';
import { templateSkeleton, recordTemplateDedupError } from '../services/memory-template-dedup';

describe('templateSkeleton', () => {
  it('replaces a full UUID with <id>', () => {
    const s = templateSkeleton('Loop dc007c3b-eb4d-47e6-8274-f26fcc5f9f5b closed');
    expect(s).toBe('Loop <id> closed');
  });

  it('replaces an ISO date with <date>', () => {
    const s = templateSkeleton('Created on 2026-10-14 by the loop');
    expect(s).toBe('Created on <date> by the loop');
  });

  it('replaces an ISO timestamp with <date>', () => {
    const s = templateSkeleton('At 2026-10-14T12:30:45Z the run ended');
    expect(s).toBe('At <date> the run ended');
  });

  it('replaces a hex id (≥7 chars, mixed digit+letter) with <id>', () => {
    const s = templateSkeleton('sha abcdef123 caused the failure');
    expect(s).toBe('sha <id> caused the failure');
  });

  it('does not replace a short all-digit token as a hex id', () => {
    // "12345" is only 5 chars and has no letter — stays as a number → <n>
    const s = templateSkeleton('run 12345 done');
    expect(s).toBe('run <n> done');
  });

  it('replaces integers with <n>', () => {
    const s = templateSkeleton('score was 97 out of 100');
    expect(s).toBe('score was <n> out of <n>');
  });

  it('replaces decimals with <n>', () => {
    const s = templateSkeleton('confidence 0.85 recorded');
    expect(s).toBe('confidence <n> recorded');
  });

  it('replaces percentages with <n>', () => {
    const s = templateSkeleton('improved by 12% this week');
    expect(s).toBe('improved by <n> this week');
  });

  it('replaces negative numbers with <n>', () => {
    const s = templateSkeleton('delta -3 points');
    expect(s).toBe('delta <n> points');
  });

  it('collapses whitespace and trims', () => {
    const s = templateSkeleton('  hello   world  \n\t foo  ');
    expect(s).toBe('hello world foo');
  });

  it('returns empty string for empty input', () => {
    expect(templateSkeleton('')).toBe('');
  });

  it('leaves plain text without variables unchanged (modulo trim/collapse)', () => {
    expect(templateSkeleton('always use pnpm for installs')).toBe('always use pnpm for installs');
  });

  it('handles combined content: uuid + date + number', () => {
    const s = templateSkeleton(
      'Run aaaa1111-bbbb-cccc-dddd-eeeeffff0000 on 2026-01-02 scored 42',
    );
    expect(s).toBe('Run <id> on <date> scored <n>');
  });
});

describe('recordTemplateDedupError', () => {
  function makeDb(shouldThrow = false) {
    return {
      prepare: vi.fn().mockReturnValue({
        run: vi.fn(() => { if (shouldThrow) throw new Error('no table'); }),
      }),
    };
  }

  it('does not throw when the judgments insert succeeds', () => {
    const db = makeDb(false);
    expect(() => recordTemplateDedupError(db as any, {
      mode: 'shadow', stage: 'lookup', error: new Error('boom'), sourceRef: null,
    })).not.toThrow();
  });

  it('does not throw when the judgments table is absent (insert throws)', () => {
    const db = makeDb(true);
    expect(() => recordTemplateDedupError(db as any, {
      mode: 'enforce', stage: 'record', error: new Error('missing table'), sourceRef: 'loop:abc123',
    })).not.toThrow();
  });

  it('logs a warning containing the stage and mode', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      recordTemplateDedupError(makeDb() as any, {
        mode: 'shadow', stage: 'enforce', error: new Error('db down'), sourceRef: null,
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('enforce');
      expect(warn.mock.calls[0][0]).toContain('shadow');
    } finally { warn.mockRestore(); }
  });

  it('stringifies non-Error values for the log message', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      recordTemplateDedupError(makeDb() as any, {
        mode: 'off', stage: 'lookup', error: 'raw string failure', sourceRef: null,
      });
      expect(warn.mock.calls[0][0]).toContain('raw string failure');
    } finally { warn.mockRestore(); }
  });

  it('uses "pending" when subjectId is omitted', () => {
    const db = makeDb(false) as any;
    recordTemplateDedupError(db, {
      mode: 'shadow', stage: 'record', error: new Error('x'), sourceRef: null,
    });
    // The run call receives 'pending' as the subject_id (2nd arg after id)
    const runArgs = db.prepare().run.mock.calls[0];
    expect(runArgs[1]).toBe('pending');
  });

  it('passes through an explicit subjectId', () => {
    const db = makeDb(false) as any;
    recordTemplateDedupError(db, {
      mode: 'enforce', stage: 'lookup', error: new Error('y'), subjectId: 'cand-42', sourceRef: null,
    });
    const runArgs = db.prepare().run.mock.calls[0];
    expect(runArgs[1]).toBe('cand-42');
  });
});
