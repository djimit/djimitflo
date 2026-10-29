/**
 * O1a (re-20261029 C-reliability §3a, candidate 1): stalls were log-only — 0/20 non-CI defects were caught by a monitor and
 * the best signals fired days before a human saw them. A NEW stall subsystem is now persisted as one `judgments` row
 * (judgment 'stall', subject = subsystem, answers = detail) and pushed as one Telegram line through the operator push
 * path (TELEGRAM_PUSH_ENABLED, quiet hours, hourly cap counted apart from approvals). A subsystem still present on the next
 * tick is not new; one that clears and returns is new again. The previous tick is read back from the rows (restart-safe).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { recordStallTransitions, stallWatchTick, type Stall } from '../services/stall-watch';
import { pushApproval, pushStall, setPushSender } from '../services/operator-push';

let db: Database.Database;
const alerts: string[] = [];
const sender = { requestApproval: vi.fn(async () => undefined), broadcastAlert: vi.fn(async (t: string) => { alerts.push(t); }) };
const NOON = new Date('2026-10-25T21:00:00Z');
const ON = { TELEGRAM_PUSH_ENABLED: 'true', TELEGRAM_PUSH_MAX_PER_HOUR: '2' };
const stall = (subsystem: string, detail = `${subsystem} detail`): Stall => ({ subsystem, since: '2026-10-25T20:00:00Z', detail });
const rows = () => db.prepare("SELECT subject_type, subject_id, mode, decision, answers_json FROM judgments WHERE judgment = 'stall' ORDER BY rowid").all() as
  Array<{ subject_type: string; subject_id: string; mode: string; decision: string; answers_json: string }>;
const names = (s: Stall[]) => s.map((x) => x.subsystem);

beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); alerts.length = 0; setPushSender(sender); });
afterEach(() => { setPushSender(null); db.close(); vi.restoreAllMocks(); });

describe('recordStallTransitions: one row per NEW subsystem (dedupe against the previous tick)', () => {
  it('persists a new subsystem once, not again while it persists; clears and re-opens', () => {
    const t = (h: number) => new Date(NOON.getTime() + h * 3_600_000);
    expect(names(recordStallTransitions(db, [stall('zero_success:maker:remote@workstation/atomic')], t(0)))).toEqual(['zero_success:maker:remote@workstation/atomic']);
    expect(rows()).toEqual([expect.objectContaining({ subject_type: 'subsystem', subject_id: 'zero_success:maker:remote@workstation/atomic', mode: 'annotation', decision: 'open' })]);
    expect(JSON.parse(rows()[0].answers_json)).toMatchObject({ detail: 'zero_success:maker:remote@workstation/atomic detail', since: '2026-10-25T20:00:00Z' });
    // still there next tick: nothing new; a second subsystem appears: only it is new
    expect(names(recordStallTransitions(db, [stall('zero_success:maker:remote@workstation/atomic')], t(1)))).toEqual([]);
    expect(names(recordStallTransitions(db, [stall('zero_success:maker:remote@workstation/atomic'), stall('gym:no_outcome_6h')], t(2)))).toEqual(['gym:no_outcome_6h']);
    expect(rows().filter((r) => r.decision === 'open')).toHaveLength(2);
    // gone: one 'cleared' row each; back: new again
    expect(recordStallTransitions(db, [], t(3))).toEqual([]);
    expect(rows().filter((r) => r.decision === 'cleared').map((r) => r.subject_id).sort()).toEqual(['gym:no_outcome_6h', 'zero_success:maker:remote@workstation/atomic']);
    expect(recordStallTransitions(db, [], t(4))).toEqual([]);
    expect(rows()).toHaveLength(4);
    expect(names(recordStallTransitions(db, [stall('gym:no_outcome_6h')], t(5)))).toEqual(['gym:no_outcome_6h']);
  });

  it('the previous tick survives a restart (read from the rows, not memory)', () => {
    recordStallTransitions(db, [stall('runtime_admission:djimitsec')], NOON);
    // a fresh process reads the same DB: an ongoing stall is not re-announced after a deploy
    expect(recordStallTransitions(db, [stall('runtime_admission:djimitsec')], new Date(NOON.getTime() + 60_000))).toEqual([]);
  });
});

describe('pushStall: the operator push path, its flag, quiet hours and an hourly cap that never crowds out approvals', () => {
  it('off by default; on: one line per new stall; quiet hours and the cap hold', async () => {
    expect(await pushStall(db, stall('a'), {}, NOON)).toBe('disabled');
    expect(await pushStall(db, stall('a'), ON, NOON)).toBe('sent');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/^Stall: a since 2026-10-25T20:00:00Z/);
    expect(alerts[0]).toContain('a detail');
    expect(await pushStall(db, stall('b'), { ...ON, TELEGRAM_QUIET_HOURS: '20-7' }, NOON)).toBe('quiet');
    expect(await pushStall(db, stall('b'), ON, NOON)).toBe('sent');
    expect(await pushStall(db, stall('c'), ON, NOON)).toBe('capped');
    expect(alerts).toHaveLength(2);
    // stall pushes count apart: an approval still goes out under the same cap
    expect(await pushApproval(db, { id: 'ap1', title: 't', risk_level: 'low' }, ON, NOON)).toBe('sent');
  });

  it('no sender: nothing sent, never throws', async () => {
    setPushSender(null);
    expect(await pushStall(db, stall('a'), ON, NOON)).toBe('no_sender');
  });
});

describe('stallWatchTick: detect → persist new → push new', () => {
  it('replay 25-10 21Z: remote zero_success fires → one row and one message; the next tick sends nothing', async () => {
    const NOW = Date.parse('2026-10-25T21:00:00Z');
    db.pragma('foreign_keys = OFF'); // leases without their loop_runs rows
    for (let i = 0; i < 5; i++) {
      db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, 'maker', 'remote', 'failed', ?, ?, ?)`)
        .run(`l${i}`, `r${i}`, JSON.stringify({ model: 'workstation/atomic', failure_reason: `maker_gate_failed:lease_not_active_${i}` }), new Date(NOW - (i + 1) * 3_600_000).toISOString(), new Date(NOW).toISOString());
    }
    const env = { VALUE_ANOMALY_ALARM: 'on', DJIMITFLO_SKILLS_DIR: __dirname, DJIMIT_SKILL_TRAINING_EVAL_RUNNER: __filename };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const notify = vi.fn(async (s: Stall) => pushStall(db, s, ON, new Date(NOW)));
    const first = await stallWatchTick(db, notify, NOW, env);
    expect(names(first)).toContain('zero_success:maker:remote@workstation/atomic');
    expect(rows().map((r) => r.subject_id)).toContain('zero_success:maker:remote@workstation/atomic');
    expect(alerts.some((a) => a.startsWith('Stall: zero_success:maker:remote@workstation/atomic'))).toBe(true);
    const sentFirst = notify.mock.calls.length;
    expect(await stallWatchTick(db, notify, NOW + 3_600_000, env)).toEqual([]);
    expect(notify.mock.calls.length).toBe(sentFirst);
  });
});
