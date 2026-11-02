import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { operatorCockpit } from '../services/operator-cockpit';
import { buildDigest } from '../services/operator-push';
import { countOpenLoopPrs, listDraftPrs } from '../services/loop-draft-pr-service';
import { listSchedulers, noteScheduler, resetSchedulers } from '../services/scheduler-registry';
import { SelfHealingScheduler } from '../services/self-healing-scheduler';

// Cockpit 3.0 follow-ups: an unwatched subsystem or a stopped scheduler is not 'healthy'; an unreadable count is 'unknown', not 0.
let db: Database.Database;
const NOW = Date.now();
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); resetSchedulers(NOW); });
afterEach(() => { db.close(); resetSchedulers(); });

it('a stall detector whose query fails is reported, makes the snapshot UNKNOWN and lands in errors', () => {
  db.exec('DROP TABLE IF EXISTS skill_outcomes'); // created lazily elsewhere
  const c = operatorCockpit(db, NOW, { EVOLUTION_GYM_REMOTE_ENABLED: 'true' } as NodeJS.ProcessEnv);
  expect(c.detectors.find((d) => d.name === 'gym')?.status).toBe('error');
  expect(c.errors.some((e) => e.section === 'detector:gym')).toBe(true);
  expect(['UNKNOWN', 'BREACHED']).toContain(c.health);
});

it('an armed scheduler that never ticks degrades the cockpit; its status counts are exposed', () => {
  resetSchedulers(NOW - 3 * 3_600_000); // booted 3 h ago
  noteScheduler('silent', 'SILENT_ENABLED', true, 60_000);
  const c = operatorCockpit(db, NOW, {} as NodeJS.ProcessEnv);
  expect(c.schedulers.by_status.armed_not_ticking).toBe(1);
  expect(c.schedulers.health).toBe('BREACHED');
  expect(c.health).not.toBe('HEALTHY');
});

it('the daily digest says unknown for counts it could not read, never 0', () => {
  db.exec('DROP TABLE approvals; DROP TABLE self_improvements');
  const d = buildDigest(db, NOW, {} as NodeJS.ProcessEnv);
  expect(d.text).toContain('unknown verified');
  expect(d.text).not.toContain('Waiting for you: 0');
  expect(d.text).toMatch(/Waiting for you: ≥ \d+ \(\d+ unknown\)/);
});

it('loop-PR helpers return null (unknown) when the read fails, not 0', () => {
  db.exec('DROP TABLE loop_runs');
  expect(countOpenLoopPrs(db)).toBeNull();
  expect(listDraftPrs(db)).toMatchObject({ total: null, unsettled: null, rows: [] });
});

it('the index.ts schedulers report their ticks, so execution is proven instead of unknown', () => {
  const s = new SelfHealingScheduler(db);
  noteScheduler('self_healing', 'SELF_HEALING_SCHEDULER_ENABLED', true, s.intervalMinutes() * 60_000);
  try { s.tick(); } catch { /* the tick's own work may fail on a bare schema; the tick itself happened */ }
  expect(listSchedulers().schedulers.find((x) => x.name === 'self_healing')?.status).toBe('executing');
});
