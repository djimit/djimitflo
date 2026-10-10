import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  noteScheduler,
  markRun,
  schedulerStatus,
  listSchedulers,
  schedulerHealth,
  resetSchedulers,
} from '../services/scheduler-registry';
import type { SchedulerInfo, SchedulerStatus } from '../services/scheduler-registry';

describe('scheduler-registry exports (noteScheduler, markRun, schedulerStatus, listSchedulers, schedulerHealth, resetSchedulers)', () => {
  beforeEach(() => resetSchedulers(1_000_000));

  afterEach(() => resetSchedulers());

  it('noteScheduler records armed state and returns the passed flag unchanged', () => {
    expect(noteScheduler('a', 'ENABLE_A', true, 1000)).toBe(true);
    expect(noteScheduler('b', 'ENABLE_B', false, 2000)).toBe(false);
    const { schedulers } = listSchedulers();
    expect(schedulers.find((s) => s.name === 'a')?.armed).toBe(true);
    expect(schedulers.find((s) => s.name === 'b')?.armed).toBe(false);
  });

  it('noteScheduler coerces truthy non-booleans to a boolean armed flag', () => {
    noteScheduler('c', 'ENABLE_C', 1 as unknown as boolean);
    const found = listSchedulers().schedulers.find((s) => s.name === 'c');
    expect(found?.armed).toBe(true);
  });

  it('markRun records the last tick and surfaces errors as short messages', () => {
    noteScheduler('t', 'ENABLE_T', true, 1000);
    markRun('t');
    expect(schedulerStatus({ name: 't', flag: 'ENABLE_T', armed: true, interval_ms: 1000, last_run: 'x', last_error: null } as SchedulerInfo, 1_000_000)).not.toBe('failing');

    markRun('t', new Error('boom'));
    const info = listSchedulers().schedulers.find((s) => s.name === 't');
    expect(info?.last_error).toBe('boom');
    expect(info?.status).toBe('failing');
  });

  it('markRun truncates long error payloads to 200 chars and never throws', () => {
    noteScheduler('long', 'ENABLE_LONG', true, 1000);
    const big = 'x'.repeat(500);
    expect(() => markRun('long', big)).not.toThrow();
    const info = listSchedulers().schedulers.find((s) => s.name === 'long');
    expect(info?.last_error?.length).toBeLessThanOrEqual(200);
    expect(info?.last_error).toBe(big.slice(0, 200));
  });

  it('schedulerStatus returns off for disarmed schedulers regardless of ticks', () => {
    expect(schedulerStatus({ name: 'd', flag: 'ENABLE_D', armed: false, interval_ms: 1000, last_run: '2000-01-01T00:00:00.000Z', last_error: null } as SchedulerInfo, 1_000_000)).toBe('off');
  });

  it('schedulerStatus returns failing when last_error is set, even if recently ticked', () => {
    expect(
      schedulerStatus(
        { name: 'f', flag: 'ENABLE_F', armed: true, interval_ms: 1000, last_run: '2000-01-01T00:00:00.000Z', last_error: 'bad' } as SchedulerInfo,
        Date.parse('2000-01-01T00:00:00.000Z'),
      ),
    ).toBe('failing');
  });

  it('schedulerStatus returns executing when ticked within 2x interval', () => {
    const now = 10_000;
    expect(
      schedulerStatus({ name: 'e', flag: 'ENABLE_E', armed: true, interval_ms: 1000, last_run: new Date(now - 1000).toISOString(), last_error: null } as SchedulerInfo, now),
    ).toBe('executing');
  });

  it('schedulerStatus returns unknown when armed with no interval and no tick', () => {
    expect(
      schedulerStatus({ name: 'u', flag: 'ENABLE_U', armed: true, interval_ms: null, last_run: null, last_error: null } as SchedulerInfo, 1_000_000),
    ).toBe('unknown');
  });

  it('schedulerStatus returns executing when armed with no interval but a tick is present', () => {
    expect(
      schedulerStatus({ name: 'u2', flag: 'ENABLE_U2', armed: true, interval_ms: null, last_run: '2000-01-01T00:00:00.000Z', last_error: null } as SchedulerInfo, 1_000_000),
    ).toBe('executing');
  });

  it('schedulerStatus returns armed_pending inside the boot grace and armed_not_ticking past it', () => {
    const bootTime = 5_000_000;
    resetSchedulers(bootTime);
    const interval = 1000;
    const window = 2 * interval;
    const pending = schedulerStatus(
      { name: 'p', flag: 'ENABLE_P', armed: true, interval_ms: interval, last_run: null, last_error: null } as SchedulerInfo,
      bootTime + window - 1,
    );
    expect(pending).toBe('armed_pending');
    const notTicking = schedulerStatus(
      { name: 'n', flag: 'ENABLE_N', armed: true, interval_ms: interval, last_run: null, last_error: null } as SchedulerInfo,
      bootTime + window + 1,
    );
    expect(notTicking).toBe('armed_not_ticking');
  });

  it('listSchedulers sorts armed-first then by name and counts by_status', () => {
    noteScheduler('zeta', 'ENABLE_Z', false);
    noteScheduler('alpha', 'ENABLE_A', true, 1000);
    noteScheduler('mid', 'ENABLE_M', true, 1000);
    const result = listSchedulers(1_000_000);
    expect(result.schedulers.map((s) => s.name)).toEqual(['alpha', 'mid', 'zeta']);
    expect(result.armed).toBe(2);
    expect(result.off).toBe(1);
    expect(result.by_status.off).toBe(1);
    const statusKeys: SchedulerStatus[] = ['off', 'executing', 'failing', 'armed_pending', 'armed_not_ticking', 'unknown'];
    for (const k of statusKeys) expect(result.by_status[k]).toBeTypeOf('number');
  });

  it('listSchedulers health is BREACHED when an armed scheduler is failing', () => {
    noteScheduler('bad', 'ENABLE_BAD', true, 1000);
    markRun('bad', new Error('nope'));
    expect(listSchedulers(1_000_000).health).toBe('BREACHED');
  });

  it('listSchedulers health is BREACHED when an armed scheduler stops ticking past grace', () => {
    const bootTime = 1_000_000;
    resetSchedulers(bootTime);
    noteScheduler('stale', 'ENABLE_STALE', true, 1000);
    expect(listSchedulers(bootTime + 10_000).health).toBe('BREACHED');
  });

  it('listSchedulers health is UNKNOWN when an armed scheduler has no interval and no tick', () => {
    noteScheduler('opaque', 'ENABLE_OPAQUE', true, null);
    expect(listSchedulers(1_000_000).health).toBe('UNKNOWN');
  });

  it('listSchedulers health is HEALTHY when all armed schedulers tick within window', () => {
    noteScheduler('ok', 'ENABLE_OK', true, 1000);
    markRun('ok');
    expect(listSchedulers(1_000_000).health).toBe('HEALTHY');
  });

  it('schedulerHealth returns the health and by_status projection of listSchedulers', () => {
    noteScheduler('ok', 'ENABLE_OK', true, 1000);
    markRun('ok');
    noteScheduler('down', 'ENABLE_DOWN', false);
    const health = schedulerHealth(1_000_000);
    expect(health.health).toBe('HEALTHY');
    expect(health.by_status.off).toBe(1);
    expect(health.by_status.executing).toBeGreaterThanOrEqual(1);
  });

  it('resetSchedulers clears the registry and resets boot time', () => {
    noteScheduler('temp', 'ENABLE_TEMP', true, 1000);
    markRun('temp');
    resetSchedulers(2_000_000);
    const result = listSchedulers(2_000_000);
    expect(result.schedulers).toEqual([]);
    expect(result.armed).toBe(0);
  });
});