import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import {
  CI_WATCH_PER_TICK,
  ciWatchIntervalMs,
  ciWatchMode,
  startLoopPrCiWatch,
} from '../services/loop-pr-ci-watch';

describe('CI_WATCH_PER_TICK', () => {
  it('is the documented per-tick bound of 10', () => {
    expect(CI_WATCH_PER_TICK).toBe(10);
  });
});

describe('ciWatchMode', () => {
  it("defaults to 'off' when LOOP_PR_CI_WATCH is unset", () => {
    expect(ciWatchMode({})).toBe('off');
  });

  it("returns 'off' for any value other than 'shadow'", () => {
    expect(ciWatchMode({ LOOP_PR_CI_WATCH: 'on' })).toBe('off');
    expect(ciWatchMode({ LOOP_PR_CI_WATCH: 'true' })).toBe('off');
    expect(ciWatchMode({ LOOP_PR_CI_WATCH: '1' })).toBe('off');
  });

  it("returns 'shadow' only when LOOP_PR_CI_WATCH is exactly 'shadow'", () => {
    expect(ciWatchMode({ LOOP_PR_CI_WATCH: 'shadow' })).toBe('shadow');
    expect(ciWatchMode({ LOOP_PR_CI_WATCH: 'Shadow' })).toBe('off');
  });
});

describe('ciWatchIntervalMs', () => {
  it('defaults to 15 minutes when LOOP_PR_CI_WATCH_MINUTES is unset', () => {
    expect(ciWatchIntervalMs({})).toBe(15 * 60_000);
  });

  it('defaults to 15 minutes for non-numeric input', () => {
    expect(ciWatchIntervalMs({ LOOP_PR_CI_WATCH_MINUTES: 'abc' })).toBe(15 * 60_000);
  });

  it('defaults to 15 minutes for zero or negative input', () => {
    expect(ciWatchIntervalMs({ LOOP_PR_CI_WATCH_MINUTES: '0' })).toBe(15 * 60_000);
    expect(ciWatchIntervalMs({ LOOP_PR_CI_WATCH_MINUTES: '-5' })).toBe(15 * 60_000);
  });

  it('converts a positive minute value to milliseconds', () => {
    expect(ciWatchIntervalMs({ LOOP_PR_CI_WATCH_MINUTES: '30' })).toBe(30 * 60_000);
    expect(ciWatchIntervalMs({ LOOP_PR_CI_WATCH_MINUTES: '1' })).toBe(60_000);
  });
});

describe('startLoopPrCiWatch', () => {
  let db: Database.Database;
  const prevFlag = process.env.LOOP_PR_CI_WATCH;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(schema);
    runMigrations(db);
    delete process.env.LOOP_PR_CI_WATCH;
  });

  afterEach(() => {
    if (prevFlag === undefined) delete process.env.LOOP_PR_CI_WATCH;
    else process.env.LOOP_PR_CI_WATCH = prevFlag;
    db.close();
  });

  it('returns null when the flag is off (default)', () => {
    expect(startLoopPrCiWatch(db)).toBeNull();
  });

  it('returns a stop function when the flag is shadow', () => {
    process.env.LOOP_PR_CI_WATCH = 'shadow';
    const stop = startLoopPrCiWatch(db, 60_000);
    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();
  });

  it('honours an explicit interval argument without reading env', () => {
    process.env.LOOP_PR_CI_WATCH = 'shadow';
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const stop = startLoopPrCiWatch(db, 42_000);
    expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 42_000);
    stop();
    setSpy.mockRestore();
  });

  it('the returned stop clears the interval (idempotent, no throw on repeat calls)', () => {
    process.env.LOOP_PR_CI_WATCH = 'shadow';
    const stop = startLoopPrCiWatch(db, 60_000);
    stop();
    expect(() => stop()).not.toThrow();
  });
});