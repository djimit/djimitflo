import { beforeEach, vi } from 'vitest';

/**
 * Time-travel harness for "date bomb" tests: a test that passes today but fails on a later date because it mixes a fixed
 * date (a seeded row, a registry stop date, a literal ISO string) with code that reads the real clock.
 *
 * TIME_TRAVEL_DAYS unset (or empty): this file does nothing — no fake timers, no hook, no interval, the global Date untouched.
 * TIME_TRAVEL_DAYS=N (an integer, 0 included): only Date is faked and moved to the real time + N days; timers,
 * process.nextTick and performance stay real. The setting is re-applied before each test whenever the timers are real again
 * (a test that called vi.useRealTimers() in an afterEach). A test that fakes the timers itself wins inside that test:
 * vi.useFakeTimers() reinstalls with the test's own config, and vi.setSystemTime() pins its own date.
 * scripts/time-travel-tests.mjs runs the suite at 0 and at N and reports the tests that pass at 0 and fail at N; running 0
 * through this harness too keeps the fake-Date mechanics out of the diff.
 *
 * The fake clock follows the real one through a real 1 ms interval that advances it by the real time elapsed since the
 * last step — like shouldAdvanceTime, but without its drift: shouldAdvanceTime adds a fixed delta per interval callback,
 * so under load (late callbacks) the fake clock fell behind and a test that waited 50 ms real time saw 47 ms. Between two
 * steps (inside synchronous code) the clock stands still. Not shifted: SQLite's 'now' / CURRENT_TIMESTAMP, child processes
 * and file mtimes, which all read the OS clock.
 */
const DAY_MS = 86_400_000;

/** null = off (unset or empty); otherwise the shift in ms. A value that is not an integer is a harness error, not "off". */
export function timeTravelOffsetMs(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const days = Number(raw);
  if (!Number.isInteger(days)) throw new Error(`TIME_TRAVEL_DAYS must be an integer number of days, got ${JSON.stringify(raw)}`);
  return days * DAY_MS;
}

const offsetMs = timeTravelOffsetMs(process.env.TIME_TRAVEL_DAYS);
if (offsetMs !== null) {
  let ours: DateConstructor | null = null; // the Date this harness installed; any other Date means the test took over
  let lastReal = 0;
  const travel = (): void => {
    vi.useFakeTimers({ toFake: ['Date'] });
    lastReal = vi.getRealSystemTime();
    vi.setSystemTime(lastReal + offsetMs);
    ours = globalThis.Date;
  };
  // setInterval is never faked by this harness; a test's own vi.useFakeTimers() replaces Date, and then the step is skipped
  const step = setInterval(() => {
    const real = vi.getRealSystemTime();
    if (globalThis.Date === ours && real > lastReal) vi.advanceTimersByTime(real - lastReal);
    lastReal = real;
  }, 1);
  step.unref();
  travel(); // before the test file is imported: module-level Date reads see the shifted clock too
  beforeEach(() => {
    if (!vi.isFakeTimers()) travel();
  });
}
