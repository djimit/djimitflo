import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  laneFeedbackClause,
  laneFeedbackNotes,
  laneOfPr,
  lanePaused,
  laneTally,
  recordLaneFeedback,
  type GapLane,
} from '../services/lane-feedback';

/**
 * G2/G3 exports: laneOfPr maps a loop PR to its gap lane via the joined
 * loop_runs→goals→self_improvements title; laneFeedbackNotes returns the latest
 * operator reasons; laneTally counts up/down verdicts in the feedback window.
 * These exported helpers had no test naming them; this test-only file covers them
 * with a minimal in-memory schema (only the columns lane-feedback.ts reads).
 */
let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE self_improvements (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE goals (id TEXT PRIMARY KEY, improvement_id TEXT NOT NULL);
    CREATE TABLE loop_runs (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL
    );
  `);
});
afterEach(() => { db.close(); });

/** Insert the loop_runs→goals→self_improvements chain for one PR with a given proposal title. */
function seedRun(prNumber: number, title: string, createdAt = '2026-11-16T00:00:00.000Z'): { improvementId: string } {
  const improvementId = `imp-${prNumber}`;
  const goalId = `goal-${prNumber}`;
  const runId = `run-${prNumber}`;
  db.prepare('INSERT INTO self_improvements (id, title) VALUES (?, ?)').run(improvementId, title);
  db.prepare('INSERT INTO goals (id, improvement_id) VALUES (?, ?)').run(goalId, improvementId);
  db.prepare('INSERT INTO loop_runs (id, goal_id, metadata, created_at) VALUES (?, ?, ?, ?)')
    .run(runId, goalId, JSON.stringify({ pr_number: prNumber }), createdAt);
  return { improvementId };
}

describe('laneOfPr', () => {
  it('returns the lane and improvement id for an exports-line proposal PR', () => {
    seedRun(42, 'Test untested exports of services/lane-feedback.ts');
    expect(laneOfPr(db, 42)).toEqual({ lane: 'exports', improvementId: 'imp-42' });
  });

  it('maps mutation / dashboard / packages / untested proposal titles', () => {
    seedRun(1, 'Raise the mutation score of services/x.ts');
    seedRun(2, 'Add unit tests for dashboard/src/lib/foo.ts');
    seedRun(3, 'Add unit tests for packages/shared/src/y.ts');
    seedRun(4, 'Add unit tests for services/z.ts');
    expect(laneOfPr(db, 1)?.lane).toBe('mutation');
    expect(laneOfPr(db, 2)?.lane).toBe('dashboard');
    expect(laneOfPr(db, 3)?.lane).toBe('packages');
    expect(laneOfPr(db, 4)?.lane).toBe('untested');
  });

  it('returns null when the PR is not a known test-gap loop PR', () => {
    expect(laneOfPr(db, 999)).toBeNull();
  });

  it('returns null when the title does not shape a gap lane', () => {
    seedRun(7, 'Refactor the dashboard router');
    expect(laneOfPr(db, 7)).toBeNull();
  });

  it('picks the most recent run when several runs share a pr_number', () => {
    seedRun(5, 'Test untested exports of services/a.ts', '2026-11-01T00:00:00.000Z');
    db.prepare('INSERT INTO loop_runs (id, goal_id, metadata, created_at) VALUES (?, ?, ?, ?)')
      .run('run-5b', 'goal-5', JSON.stringify({ pr_number: 5 }), '2026-11-15T00:00:00.000Z');
    expect(laneOfPr(db, 5)?.improvementId).toBe('imp-5');
  });
});

describe('laneFeedbackNotes', () => {
  it('returns [] when no feedback has been recorded for the lane', () => {
    expect(laneFeedbackNotes(db, 'exports')).toEqual([]);
  });

  it('returns the latest reasons, newest first, prefixed useful/not useful', () => {
    seedRun(10, 'Test untested exports of services/lane-feedback.ts');
    const t0 = new Date('2026-11-10T00:00:00.000Z');
    const t1 = new Date('2026-11-12T00:00:00.000Z');
    recordLaneFeedback(db, { prNumber: 10, verdict: 'up', reason: 'clear diff', actor: 'op' }, t0);
    recordLaneFeedback(db, { prNumber: 10, verdict: 'down', reason: 'too broad', actor: 'op' }, t1);
    expect(laneFeedbackNotes(db, 'exports')).toEqual(['not useful: too broad', 'useful: clear diff']);
  });

  it('honours the limit argument', () => {
    seedRun(11, 'Test untested exports of services/b.ts');
    for (let i = 0; i < 5; i++) {
      recordLaneFeedback(db, { prNumber: 11, verdict: 'down', reason: `r${i}`, actor: 'op' }, new Date(`2026-11-0${i + 1}T00:00:00.000Z`));
    }
    expect(laneFeedbackNotes(db, 'exports', 2)).toHaveLength(2);
  });

  it('omits rows whose reason was blank', () => {
    seedRun(12, 'Test untested exports of services/c.ts');
    recordLaneFeedback(db, { prNumber: 12, verdict: 'up', actor: 'op' });
    expect(laneFeedbackNotes(db, 'exports')).toEqual([]);
  });
});

describe('laneTally', () => {
  it('counts only feedback within the 14-day window', () => {
    seedRun(20, 'Test untested exports of services/d.ts');
    recordLaneFeedback(db, { prNumber: 20, verdict: 'up', actor: 'op' }, new Date('2026-10-01T00:00:00.000Z'));
    recordLaneFeedback(db, { prNumber: 20, verdict: 'down', actor: 'op' }, new Date('2026-11-15T00:00:00.000Z'));
    const tally = laneTally(db, 'exports', new Date('2026-11-16T00:00:00.000Z'));
    expect(tally).toEqual({ up: 0, down: 1 });
  });

  it('returns 0/0 for a lane with no feedback', () => {
    expect(laneTally(db, 'mutation')).toEqual({ up: 0, down: 0 });
  });

  it('respects the LANE_FEEDBACK_DAYS env override', () => {
    seedRun(21, 'Test untested exports of services/e.ts');
    recordLaneFeedback(db, { prNumber: 21, verdict: 'up', actor: 'op' }, new Date('2026-11-01T00:00:00.000Z'));
    process.env.LANE_FEEDBACK_DAYS = '30';
    try {
      const tally = laneTally(db, 'exports', new Date('2026-11-16T00:00:00.000Z'));
      expect(tally).toEqual({ up: 1, down: 0 });
    } finally {
      delete process.env.LANE_FEEDBACK_DAYS;
    }
  });
});

describe('lanePaused', () => {
  it('pauses a lane with >= 3 down and more down than up', () => {
    seedRun(30, 'Test untested exports of services/f.ts');
    for (let i = 0; i < 3; i++) {
      recordLaneFeedback(db, { prNumber: 30, verdict: 'down', actor: 'op' }, new Date(`2026-11-1${i}T00:00:00.000Z`));
    }
    expect(lanePaused(db, 'exports', new Date('2026-11-16T00:00:00.000Z'))).toBe(true);
  });

  it('does not pause when up votes meet or exceed down votes', () => {
    seedRun(31, 'Test untested exports of services/g.ts');
    for (let i = 0; i < 3; i++) {
      recordLaneFeedback(db, { prNumber: 31, verdict: 'down', actor: 'op' }, new Date(`2026-11-1${i}T00:00:00.000Z`));
    }
    for (let i = 0; i < 3; i++) {
      recordLaneFeedback(db, { prNumber: 31, verdict: 'up', actor: 'op' }, new Date(`2026-11-1${i}T00:00:00.000Z`));
    }
    expect(lanePaused(db, 'exports', new Date('2026-11-16T00:00:00.000Z'))).toBe(false);
  });
});

describe('laneFeedbackClause', () => {
  it('returns "" without feedback', () => {
    expect(laneFeedbackClause(db, 'exports' as GapLane)).toBe('');
  });

  it('returns the operator-feedback clause joined by " | "', () => {
    seedRun(40, 'Test untested exports of services/h.ts');
    recordLaneFeedback(db, { prNumber: 40, verdict: 'down', reason: 'too noisy', actor: 'op' }, new Date('2026-11-15T00:00:00.000Z'));
    const clause = laneFeedbackClause(db, 'exports');
    expect(clause).toContain('OPERATOR FEEDBACK ON THIS LANE');
    expect(clause).toContain('not useful: too noisy');
  });
});
