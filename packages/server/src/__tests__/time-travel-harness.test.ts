import { afterEach, describe, expect, it, vi } from 'vitest';
import { timeTravelOffsetMs } from './helpers/time-travel';

const DAY_MS = 86_400_000;
const env = process.env.TIME_TRAVEL_DAYS;
const on = timeTravelOffsetMs(env) !== null; // unset and empty are both off

describe('time-travel harness (helpers/time-travel.ts, a vitest setup file)', () => {
  afterEach(() => {
    if (env === undefined) delete process.env.TIME_TRAVEL_DAYS;
    else process.env.TIME_TRAVEL_DAYS = env;
    vi.resetModules();
  });

  it('parses TIME_TRAVEL_DAYS: unset or empty is off, an integer is a shift, anything else is an error', () => {
    expect(timeTravelOffsetMs(undefined)).toBeNull();
    expect(timeTravelOffsetMs('')).toBeNull();
    expect(timeTravelOffsetMs('  ')).toBeNull();
    expect(timeTravelOffsetMs('0')).toBe(0);
    expect(timeTravelOffsetMs('7')).toBe(7 * DAY_MS);
    expect(timeTravelOffsetMs('-1')).toBe(-DAY_MS);
    expect(() => timeTravelOffsetMs('1.5')).toThrow(/integer/);
    expect(() => timeTravelOffsetMs('seven')).toThrow(/integer/);
  });

  it.runIf(!on)('unset: loading the setup file installs nothing — real timers, the same Date, the real clock', async () => {
    const before = globalThis.Date;
    delete process.env.TIME_TRAVEL_DAYS;
    await import('./helpers/time-travel');
    expect(vi.isFakeTimers()).toBe(false);
    expect(globalThis.Date).toBe(before);
    expect(Math.abs(Date.now() - vi.getRealSystemTime())).toBeLessThan(1_000);
  });

  it.runIf(on)('set: only Date is shifted, by N days, and it keeps ticking', async () => {
    const offset = timeTravelOffsetMs(env) as number;
    expect(vi.isFakeTimers()).toBe(true);
    expect(Math.abs(Date.now() - (vi.getRealSystemTime() + offset))).toBeLessThan(1_000);
    const t0 = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 60)); // a real timer: setTimeout is not faked
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50); // follows the real clock, not a fixed delta per callback
  });

  it.runIf(on)("a test's own fake timers win inside that test, and the harness never moves them", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await new Promise((resolve) => setTimeout(resolve, 30)); // real time passes; the harness step must skip this clock
    expect(new Date().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    vi.useRealTimers(); // the setup file's beforeEach shifts the next test again
  });

  it.runIf(on)('after a test restored the real timers, the next test is shifted again', () => {
    const offset = timeTravelOffsetMs(env) as number;
    expect(vi.isFakeTimers()).toBe(true);
    expect(Math.abs(Date.now() - (vi.getRealSystemTime() + offset))).toBeLessThan(1_000);
  });
});
