import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { detectStallsWithHealth, recordRecoveryActions } from '../services/stall-watch';
import { startEvolutionEstimators } from '../services/evolution-estimators';
import { guardTick, healSchedulers, listSchedulers, markRun, noteScheduler, quarantinedSchedulers, registerRestart, resetSchedulers } from '../services/scheduler-registry';

// Restore Evolutionary Health P0.1 (prod 11-10): evolution_estimators showed 'armed but not ticking' after a mid-day
// restart — its hourly tick returned early ('today already written') before markRun. Plus the self-heal invariant.
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); resetSchedulers(0); });
afterEach(() => { db.close(); resetSchedulers(); vi.useRealTimers(); });

const status = (name: string, now: number) => listSchedulers(now).schedulers.find((s) => s.name === name)!;

it('a scheduler whose tick returns early (estimates already written today) still marks its run', () => {
  const day = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO evolution_estimates (id, estimator, scope, as_of_day, computed_at, n, status, detail_json)
    VALUES ('e1', 'x', 'all', ?, ?, 1, 'ok', '{}')`).run(day, new Date().toISOString());
  const stop = startEvolutionEstimators(db, 3_600_000, { EVOLUTION_ESTIMATORS_ENABLED: 'true' } as NodeJS.ProcessEnv);
  noteScheduler('evolution_estimators', 'EVOLUTION_ESTIMATORS_ENABLED', !!stop, 3_600_000);
  stop?.();
  const s = status('evolution_estimators', Date.now() + 3 * 3_600_000 - 1); // 3 h after a boot at 0 would be not-ticking
  expect(s.last_run).not.toBeNull();
});

it('a throwing tick (sync or async) keeps ticking and reports failing, never kills the interval', async () => {
  vi.useFakeTimers();
  let calls = 0;
  noteScheduler('boom', 'X', true, 1000);
  const t = setInterval(guardTick('boom', () => { calls += 1; throw new Error('db gone'); }), 1000);
  vi.advanceTimersByTime(3500);
  clearInterval(t);
  expect(calls).toBe(3);
  expect(status('boom', Date.now()).status).toBe('failing');
  noteScheduler('aboom', 'X', true, 1000);
  guardTick('aboom', () => Promise.reject(new Error('rejected')))();
  await vi.runAllTimersAsync();
  await Promise.resolve();
  expect(status('aboom', Date.now()).last_error).toBe('rejected');
});

it('armed-not-ticking: exactly one restart, then quarantine + escalation as a stall; recovery events recorded', () => {
  let restarts = 0;
  noteScheduler('stuck', 'X', true, 1000);
  registerRestart('stuck', () => { restarts += 1; });
  const t0 = 10_000; // boot at 0, interval 1 s → past the 2 s grace
  expect(status('stuck', t0).status).toBe('armed_not_ticking');
  const first = healSchedulers(t0, 'act');
  expect(first.map((a) => a.result)).toEqual(['diagnosed', 'restarted']);
  expect(restarts).toBe(1);
  expect(healSchedulers(t0 + 500, 'act')).toEqual([]); // inside the verify window
  const later = healSchedulers(t0 + 1000 + 10 * 60_000 + 1, 'act');
  expect(later.map((a) => a.result)).toEqual(['quarantined']);
  expect(healSchedulers(t0 + 3 * 3_600_000, 'act')).toEqual([]); // no further restarts
  expect(restarts).toBe(1);
  expect(status('stuck', t0 + 3 * 3_600_000).status).toBe('quarantined');
  expect(listSchedulers(t0).health).toBe('BREACHED');
  expect(quarantinedSchedulers()).toEqual(['stuck']);
  expect(detectStallsWithHealth(db, Date.now(), {} as NodeJS.ProcessEnv).stalls.map((s) => s.subsystem)).toContain('scheduler:stuck');
  recordRecoveryActions(db, [...first, ...later]);
  const rows = db.prepare("SELECT decision, answers_json FROM judgments WHERE judgment = 'scheduler_recovery' ORDER BY created_at, rowid").all() as Array<{ decision: string; answers_json: string }>;
  expect(rows.map((r) => r.decision)).toEqual(['diagnosed', 'restarted', 'quarantined']);
  const a = JSON.parse(rows[1].answers_json);
  expect(a).toMatchObject({ failure_id: expect.stringMatching(/^sched-stuck-/), strategy: 'restart', attempt: 1, result: 'restarted' });
  expect(a.next_action).toBeTruthy();
});

it('a restart that brings the tick back records recovered; shadow never restarts; no restart function quarantines at once', () => {
  let restarts = 0;
  noteScheduler('back', 'X', true, 1000);
  registerRestart('back', () => { restarts += 1; });
  healSchedulers(10_000, 'act');
  markRun('back');
  expect(healSchedulers(Date.now(), 'act').map((a) => a.result)).toEqual(['recovered']);

  noteScheduler('shadowed', 'X', true, 1000);
  registerRestart('shadowed', () => { restarts += 1; });
  noteScheduler('bare', 'X', true, 1000);
  const shadow = healSchedulers(10_000, 'shadow');
  expect(restarts).toBe(1); // only 'back' was ever restarted
  expect(shadow.filter((a) => a.scheduler === 'shadowed').map((a) => a.result)).toEqual(['diagnosed']);
  expect(shadow.filter((a) => a.scheduler === 'bare').map((a) => a.result)).toEqual(['diagnosed', 'quarantined']);
  expect(healSchedulers(10_000, 'off')).toEqual([]);
});
