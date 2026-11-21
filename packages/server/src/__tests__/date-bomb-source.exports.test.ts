import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dateBombCommand, startDateBombLane } from '../services/date-bomb-source';

/**
 * Exports: dateBombCommand builds the per-run acceptance command, and startDateBombLane arms the
 * daily date-bomb scheduler. Neither was named by an existing test; this test-only file covers them.
 */

const origFlag = process.env.DATE_BOMB_LANE;

beforeEach(() => { delete process.env.DATE_BOMB_LANE; });
afterEach(() => {
  if (origFlag === undefined) delete process.env.DATE_BOMB_LANE;
  else process.env.DATE_BOMB_LANE = origFlag;
});

describe('dateBombCommand', () => {
  it('builds the strict detector command for a file and horizon', () => {
    expect(dateBombCommand('packages/server/src/foo.test.ts', 7))
      .toBe('node scripts/time-travel-tests.mjs --strict --days 7 packages/server/src/foo.test.ts');
  });

  it('uses the given horizon value verbatim', () => {
    expect(dateBombCommand('packages/server/src/bar.test.ts', 30))
      .toBe('node scripts/time-travel-tests.mjs --strict --days 30 packages/server/src/bar.test.ts');
  });

  it('does not quote or transform unusual file paths', () => {
    expect(dateBombCommand('packages/server/src/a/b.test.ts', 1))
      .toBe('node scripts/time-travel-tests.mjs --strict --days 1 packages/server/src/a/b.test.ts');
  });
});

describe('startDateBombLane', () => {
  // The lane captures db/loops but only touches them inside a tick scheduled 25 min out (unref'd),
  // so stubs that throw if reached are safe here.
  const loops = { prepareMakerWorktree: () => { throw new Error('should not tick during this test'); } };
  const db = { prepare: () => { throw new Error('should not tick during this test'); } } as unknown as Parameters<typeof startDateBombLane>[0];

  it('returns null when DATE_BOMB_LANE is off (unset)', () => {
    expect(startDateBombLane(db, loops)).toBeNull();
  });

  it('returns a stop function when DATE_BOMB_LANE is shadow', () => {
    process.env.DATE_BOMB_LANE = 'shadow';
    const stop = startDateBombLane(db, loops);
    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();
  });

  it('returns a stop function when DATE_BOMB_LANE is on', () => {
    process.env.DATE_BOMB_LANE = 'on';
    const stop = startDateBombLane(db, loops);
    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();
  });

  it('the stop function is idempotent', () => {
    process.env.DATE_BOMB_LANE = 'on';
    const stop = startDateBombLane(db, loops);
    expect(typeof stop).toBe('function');
    expect(() => { stop(); stop(); }).not.toThrow();
  });
});
