import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ExecutionEngine } from '../execution/execution-engine';
import { RUNTIME_ADMISSIONS, checkAdmission, decide } from '../execution/runtime-admission';
import { detectStallsWithHealth } from '../services/stall-watch';

/**
 * C-reliability O3: the admission ledger expires on 2026-11-27 (djimitsec) and 2026-12-31 (every legacy runtime). Engine-path
 * tests pin admission time (helpers/admission-now.ts) so they stay green past those dates; this file is the one place that
 * runs the real engine path after the expiries (2027-01-02) and asserts the production behaviour: an expired admission stops dispatch
 * until the operator reassesses it. No mock of runtime-admission here — the wall clock (Date only) is set past them.
 */
const DAY = 86_400_000;
const executable = RUNTIME_ADMISSIONS.filter((a) => ['ADMIT', 'CONDITIONAL', 'LEGACY_ADMITTED'].includes(decide(a).decision));
// 2027-01-02, or the day after the latest expiry once the operator has reassessed past it
const AFTER_EXPIRY = Math.max(Date.parse('2027-01-02T00:00:00Z'), ...executable.map((a) => Date.parse(a.expires_at) + DAY));
const expiredAt = (runtime: string) => `admission expired at ${RUNTIME_ADMISSIONS.find((a) => a.runtime_id === runtime)!.expires_at}`;

let db: Database.Database;
const id = 'expiry-fixture';
const start = vi.fn(async () => { throw new Error('executor must not start'); });
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(AFTER_EXPIRY);
  db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db);
  db.prepare(`INSERT INTO tasks(id,title,description,status,priority,risk_level,execution_mode,metadata)
    VALUES (?, 'Fixture', 'Read local fixture', 'pending', 'low', 'low', 'local', '{}')`).run(id);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); start.mockClear(); db.close(); });

it('after the expiries (2027-01-02) every executable admission in the ledger has expired (wall clock, no explicit now)', () => {
  expect(executable.map((a) => a.runtime_id)).toEqual(expect.arrayContaining(['djimitsec', 'opencode', 'mock', 'codex', 'claude']));
  for (const a of executable) {
    const c = checkAdmission(a.runtime_id, a.runtime_version);
    expect(c, a.runtime_id).toMatchObject({ allowed: false, reasons: [`admission expired at ${a.expires_at}`, ...decide(a).blocked_reasons] });
  }
});

it('after the expiries the engine denies dispatch to the incumbent maker and the mock runtime and never starts them', async () => {
  const engine = new ExecutionEngine(db, { broadcastTaskEvent: vi.fn(), broadcastTaskEventById: vi.fn() } as any);
  for (const kind of ['opencode', 'mock'] as const) {
    engine.registerExecutor({ kind, canExecute: () => true, start } as any);
    const r = await engine.executeTask(id, kind, 'maker');
    expect(r, kind).toEqual({ status: 'denied', reason: `RUNTIME_NOT_ADMITTED: ${expiredAt(kind)}` });
  }
  expect(start).not.toHaveBeenCalled();
  expect(db.prepare("SELECT message FROM execution_events WHERE task_id = ? AND json_extract(metadata, '$.source') = 'runtime-admission'").all(id))
    .toEqual(['opencode', 'mock'].map((k) => ({ message: `runtime admission denied: ${k} LEGACY_ADMITTED — ${expiredAt(k)}` })));
});

it('the operator rollback (RUNTIME_ADMISSION_MODE=shadow) still lets an expired runtime run, recording the failure', () => {
  vi.stubEnv('RUNTIME_ADMISSION_MODE', 'shadow');
  const engine = new ExecutionEngine(db, { broadcastTaskEvent: vi.fn(), broadcastTaskEventById: vi.fn() } as any);
  expect((engine as any).admitRuntime(id, 'opencode')).toMatchObject({ allowed: true, decision: 'LEGACY_ADMITTED', reasons: expect.arrayContaining([expiredAt('opencode')]) });
});

it('stall watch raises every admission 21 days before it expires, and health reads BREACHED', () => {
  for (const a of executable) {
    const report = detectStallsWithHealth(db, Date.parse(a.expires_at) - 21 * DAY, {});
    expect(report.stalls.map((s) => s.subsystem), a.runtime_id).toContain(`runtime_admission:${a.runtime_id}`);
    expect(report.health).toBe('BREACHED');
  }
});
