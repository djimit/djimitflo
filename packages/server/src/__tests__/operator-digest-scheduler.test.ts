import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { RUNBOOK_DEFAULTS, SCHEDULER_FLAGS } from '../services/config-defaults.generated';

/**
 * UXE-01: the operator digest / triage tick reports itself in the scheduler registry (it was the one 15-min timer the
 * registry could not see), and five flags read in code get documented defaults. operator-push keeps its timer in module
 * state, so every test imports fresh modules.
 */
const ROOT = path.resolve(__dirname, '../../../..');
const FIFTEEN_MIN = 15 * 60_000;
let db: Database.Database;
const sender = { requestApproval: vi.fn(async () => {}), broadcastAlert: vi.fn(async () => {}), requestTriage: vi.fn(async () => {}) };

const fresh = async () => {
  vi.resetModules();
  const push = await import('../services/operator-push');
  const reg = await import('../services/scheduler-registry');
  reg.resetSchedulers(Date.now());
  push.setPushSender(sender);
  return { push, reg, entry: () => reg.listSchedulers(Date.now()).schedulers.find((s) => s.name === 'operator_digest') };
};

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(schema);
  runMigrations(db);
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('UXE-01: the five code-read flags appear in RUNBOOK_DEFAULTS with their code defaults', () => {
  expect({
    LOOP_DRAFT_PR_THROTTLE_MODE: RUNBOOK_DEFAULTS.LOOP_DRAFT_PR_THROTTLE_MODE,
    LOOP_DRAFT_PR_MAX_OPEN: RUNBOOK_DEFAULTS.LOOP_DRAFT_PR_MAX_OPEN,
    VECTOR_STRICT_DIM: RUNBOOK_DEFAULTS.VECTOR_STRICT_DIM,
    RETRIEVAL_NORMALISE_SCORES: RUNBOOK_DEFAULTS.RETRIEVAL_NORMALISE_SCORES,
    TELEGRAM_PUSH_DELAY_MS: RUNBOOK_DEFAULTS.TELEGRAM_PUSH_DELAY_MS,
  }).toEqual({
    LOOP_DRAFT_PR_THROTTLE_MODE: 'off (unset)',
    LOOP_DRAFT_PR_MAX_OPEN: '5',
    VECTOR_STRICT_DIM: 'off',
    RETRIEVAL_NORMALISE_SCORES: 'off',
    TELEGRAM_PUSH_DELAY_MS: '15000 (15 s)',
  });
  expect(SCHEDULER_FLAGS).toContain('OPERATOR_DIGEST_ENABLED');
});

it('UXE-01: HEARTBEAT.md lists operator_digest at 15 min and the runbook names TELEGRAM_TRIAGE_ENABLED as its second gate', () => {
  expect(fs.readFileSync(path.join(ROOT, 'HEARTBEAT.md'), 'utf8'))
    .toContain('| operator_digest | `OPERATOR_DIGEST_ENABLED` | 15 min | `packages/server/src/services/operator-push.ts` |');
  const runbook = fs.readFileSync(path.join(ROOT, 'docs/runbooks/self-improvement-loop-operations.md'), 'utf8');
  const digestRow = runbook.split('\n').find((l) => l.startsWith('| `OPERATOR_DIGEST_ENABLED` |')) ?? '';
  expect(digestRow).toMatch(/scheduler `operator_digest`.*armed by this flag or `TELEGRAM_TRIAGE_ENABLED`/);
  // UX-19 row corrected: since #784 the panel review validates and re-asks itself; the flag gates Frontier Experts only
  const repairRow = runbook.split('\n').find((l) => l.startsWith('| `LLM_JSON_REPAIR_ENABLED` |')) ?? '';
  expect(repairRow).toMatch(/Frontier Experts only/);
  expect(repairRow).not.toMatch(/\(panel review, Frontier Experts\)/);
});

it('UXE-01: only TELEGRAM_TRIAGE_ENABLED (with push) still arms the 15-min timer, registered as armed', async () => {
  vi.stubEnv('OPERATOR_DIGEST_ENABLED', 'false');
  vi.stubEnv('TELEGRAM_PUSH_ENABLED', 'true');
  vi.stubEnv('TELEGRAM_TRIAGE_ENABLED', 'true');
  vi.useFakeTimers();
  const { push, entry } = await fresh();
  const spy = vi.spyOn(globalThis, 'setInterval');
  push.startOperatorDigest(db);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0][1]).toBe(FIFTEEN_MIN);
  expect(entry()).toMatchObject({ name: 'operator_digest', flag: 'OPERATOR_DIGEST_ENABLED', armed: true, interval_ms: FIFTEEN_MIN, status: 'armed_pending' });
});

it('UXE-01: after one tick listSchedulers reports operator_digest executing', async () => {
  vi.stubEnv('OPERATOR_DIGEST_ENABLED', 'true');
  vi.stubEnv('OPERATOR_DIGEST_HOUR', '3');
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
  const { push, reg, entry } = await fresh();
  push.startOperatorDigest(db);
  expect(entry()?.status).toBe('armed_pending');
  await vi.advanceTimersByTimeAsync(FIFTEEN_MIN);
  expect(entry()).toMatchObject({ armed: true, status: 'executing', last_run: '2026-10-06T12:15:00.000Z', last_error: null });
  expect(reg.listSchedulers(Date.now()).health).toBe('HEALTHY');
});

it('UXE-01: both flags off → armed:false, no timer, and the digest differs from main only in the "Schedulers off by flag" line', async () => {
  vi.stubEnv('OPERATOR_DIGEST_ENABLED', 'false');
  vi.stubEnv('TELEGRAM_PUSH_ENABLED', 'false');
  vi.stubEnv('TELEGRAM_TRIAGE_ENABLED', 'false');
  const { push, reg, entry } = await fresh();
  reg.noteScheduler('another_scheduler', 'ANOTHER_FLAG', false, FIFTEEN_MIN);
  const now = Date.parse('2026-10-06T12:00:00Z');
  const main = push.buildDigest(db, now).text; // the registry as main has it: no operator_digest entry
  const spy = vi.spyOn(globalThis, 'setInterval');
  push.startOperatorDigest(db);
  expect(spy).not.toHaveBeenCalled();
  expect(entry()).toMatchObject({ flag: 'OPERATOR_DIGEST_ENABLED', armed: false, status: 'off' });
  const head = push.buildDigest(db, now).text;
  const OFF = 'Schedulers off by flag:';
  expect(main.split('\n').filter((l) => l.startsWith(OFF))).toEqual([`${OFF} 1 (another_scheduler)`]);
  expect(head.split('\n').filter((l) => l.startsWith(OFF))).toEqual([`${OFF} 2 (another_scheduler, operator_digest)`]);
  const rest = (t: string) => t.split('\n').filter((l) => !l.startsWith(OFF));
  expect(rest(head)).toEqual(rest(main));
});
