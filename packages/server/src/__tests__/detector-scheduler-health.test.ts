import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { detectStalls, detectStallsWithHealth } from '../services/stall-watch';
import { listSchedulers, markRun, noteScheduler, resetSchedulers, schedulerHealth } from '../services/scheduler-registry';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';

// Cockpit 3.0 adversarial checks: a broken detector, a scheduler that never ticks and a deploy without a verdict must
// never read as healthy.
let db: Database.Database;
const NOW = Date.parse('2026-10-10T12:00:00Z');
const at = (min: number) => new Date(NOW - min * 60_000).toISOString();
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); new SkillEvolutionEngine(db); });
afterEach(() => { db.close(); resetSchedulers(); });

it('a detector whose query fails makes health UNKNOWN, not HEALTHY', () => {
  expect(detectStallsWithHealth(db, NOW, {}).health).toBe('HEALTHY');
  db.exec('DROP TABLE goals');
  const r = detectStallsWithHealth(db, NOW, {});
  expect(r.stalls).toEqual([]);
  expect(r.detectors.find((d) => d.name === 'goals')).toMatchObject({ status: 'error' });
  expect(r.health).toBe('UNKNOWN');
  expect(detectStalls(db, NOW, {})).toEqual([]); // compatible signature
});

it('flag-off detectors are not_applicable; any stall is BREACHED', () => {
  const r = detectStallsWithHealth(db, NOW, {});
  expect(r.detectors.find((d) => d.name === 'gym')?.status).toBe('not_applicable');
  expect(detectStallsWithHealth(db, NOW, { EVOLUTION_GYM_ENABLED: 'true' }).health).toBe('BREACHED'); // gym on, no outcome ever
});

it('discoveries enabled but never judged is a stall (no telemetry ≠ healthy)', () => {
  expect(detectStalls(db, NOW, { FRONTIER_EXPERT_SOURCE_UNITS_ENABLED: 'true' }).map((s) => s.subsystem)).toContain('discoveries');
});

it('deploy done without a post-deploy verdict for 40 min is a stall; verdict_ok clears it', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deploylog-')), 'deploy-log.jsonl');
  const write = (...ev: object[]) => fs.writeFileSync(file, ev.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const env = { DJIMITFLO_BUILD_COMMIT: 'abc123def', DEPLOY_LOG_PATH: file };
  write({ at: at(50), event: 'deploying', sha: 'abc123def' }, { at: at(45), event: 'done', sha: 'abc123def' });
  expect(detectStalls(db, NOW, env).map((s) => s.subsystem)).toEqual(['deploy']);
  write({ at: at(20), event: 'done', sha: 'abc123def' });
  expect(detectStalls(db, NOW, env)).toEqual([]); // inside the 40-min window
  write({ at: at(50), event: 'done', sha: 'abc123def' }, { at: at(35), event: 'verdict_ok', sha: 'abc123def' });
  expect(detectStalls(db, NOW, env)).toEqual([]);
  write({ at: at(50), event: 'done', sha: 'abc123def' }, { at: at(35), event: 'verdict_ok', sha: 'abc123def' }, { at: at(5), event: 'paused', sha: 'fff000', detail: 'stalls: panel' });
  expect(detectStalls(db, NOW, env)[0]?.detail).toContain("'paused'");
  expect(detectStallsWithHealth(db, NOW, { DEPLOY_LOG_PATH: file }).detectors.find((d) => d.name === 'deploy')?.status).toBe('not_applicable'); // no build commit
});

it('an armed scheduler that never ticks becomes armed_not_ticking after its grace', () => {
  resetSchedulers(NOW - 3 * 3_600_000);
  noteScheduler('merge_survival', 'MERGE_SURVIVAL_ENABLED', true, 3_600_000);
  noteScheduler('loop_auto_merge', 'X', true, 3_600_000);
  noteScheduler('legacy', 'Y', true, null);
  noteScheduler('off_one', 'Z', false, 3_600_000);
  markRun('loop_auto_merge');
  const s = Object.fromEntries(listSchedulers(Date.now()).schedulers.map((x) => [x.name, x.status]));
  expect(s).toEqual({ merge_survival: 'armed_not_ticking', loop_auto_merge: 'executing', legacy: 'unknown', off_one: 'off' });
  expect(schedulerHealth().health).toBe('BREACHED');
});

it('a tick before registration still counts; inside the grace an untouched scheduler is pending', () => {
  resetSchedulers(Date.now());
  markRun('early'); noteScheduler('early', 'F', true, 60_000);
  noteScheduler('fresh', 'G', true, 3_600_000);
  markRun('broken', new Error('boom')); noteScheduler('broken', 'H', true, 60_000);
  const s = Object.fromEntries(listSchedulers().schedulers.map((x) => [x.name, x.status]));
  expect(s).toEqual({ early: 'executing', fresh: 'armed_pending', broken: 'failing' });
});
