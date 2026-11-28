import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  latestCard,
  recordSignalCards,
  signalSignature,
  startSignalBridge,
  type SignalCard,
} from '../services/commons-signal-bridge';
import { listSchedulers, resetSchedulers } from '../services/scheduler-registry';

/**
 * G2/G3 exports: latestCard reads the most recent `commons_signal` judgment for a
 * signature+mode (null when absent, mismatched, or the table is missing); startSignalBridge
 * arms the background scheduler when the bridge mode is not `off` and returns a stop
 * function, or null when off. These exported helpers had no test naming them; this
 * test-only file covers them with a minimal in-memory `judgments` table.
 */
const ENV = { ...process.env };
let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE judgments (
    id TEXT PRIMARY KEY, judgment TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
    state_hash TEXT NOT NULL, mode TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT,
    answers_json TEXT, created_at TEXT NOT NULL)`);
  delete process.env.COMMONS_SIGNAL_BRIDGE_MODE;
  resetSchedulers();
});
afterEach(() => { db.close(); process.env = { ...ENV }; resetSchedulers(); });

const SIG = signalSignature('trace', 'maker|opencode|checks|missing_module');
function card(overrides: Partial<SignalCard> = {}): SignalCard {
  return {
    version: 1, signature: SIG, source: 'trace', kind: 'maker|opencode|checks|missing_module',
    title: 'maker leases fail at checks (missing_module)', count: 2,
    first_seen: '2026-11-01T00:00:00.000Z', last_seen: '2026-11-02T00:00:00.000Z',
    evidence_refs: ['lease:l0', 'lease:l1'], status: 'hypothesis', disposition: 'card',
    ...overrides,
  };
}

describe('latestCard', () => {
  it('returns null when no commons_signal judgment exists for the signature', () => {
    expect(latestCard(db, SIG, 'shadow')).toBeNull();
  });

  it('returns the recorded card for the matching signature and mode', () => {
    const c = card();
    recordSignalCards(db, [c], 'shadow');
    expect(latestCard(db, SIG, 'shadow')).toEqual(c);
  });

  it('returns null when the mode does not match (a shadow card is not an on card)', () => {
    recordSignalCards(db, [card()], 'shadow');
    expect(latestCard(db, SIG, 'on')).toBeNull();
  });

  it('returns null when the stored answers_json signature does not match the subject_id', () => {
    const stored = { ...card(), signature: 'other-sig' };
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
      VALUES (?, 'commons_signal', 'signal', ?, ?, 'shadow', 'card', 't', ?, ?)`)
      .run('j1', SIG, SIG, JSON.stringify(stored), '2026-11-02T00:00:00.000Z');
    expect(latestCard(db, SIG, 'shadow')).toBeNull();
  });

  it('returns the newest card when several were recorded for the same signature', () => {
    const now = Date.now();
    recordSignalCards(db, [card({ count: 2 })], 'shadow', now - 2_000);
    // a second window records the same kind again as a new row
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
      VALUES (?, 'commons_signal', 'signal', ?, ?, 'shadow', 'card', 't', ?, ?)`)
      .run('j2', SIG, SIG, JSON.stringify(card({ count: 5 })), new Date(now).toISOString());
    expect(latestCard(db, SIG, 'shadow')?.count).toBe(5);
  });

  it('returns null (never throws) when the judgments table is missing', () => {
    db.exec('DROP TABLE judgments');
    expect(latestCard(db, SIG, 'shadow')).toBeNull();
  });
});

describe('startSignalBridge', () => {
  it('returns null and does not arm a timer when the bridge mode is off (default)', () => {
    expect(startSignalBridge(db)).toBeNull();
    const sched = listSchedulers().schedulers.find((s) => s.name === 'commons_signal_bridge');
    expect(sched).toMatchObject({ armed: false, flag: 'COMMONS_SIGNAL_BRIDGE_MODE' });
  });

  it('returns a stop function and arms the scheduler when the mode is shadow', () => {
    process.env.COMMONS_SIGNAL_BRIDGE_MODE = 'shadow';
    const stop = startSignalBridge(db);
    expect(typeof stop).toBe('function');
    const sched = listSchedulers().schedulers.find((s) => s.name === 'commons_signal_bridge');
    expect(sched).toMatchObject({ armed: true, interval_ms: 900_000 });
    expect(() => stop!()).not.toThrow();
  });

  it('returns a stop function and arms the scheduler when the mode is on', () => {
    process.env.COMMONS_SIGNAL_BRIDGE_MODE = 'on';
    const stop = startSignalBridge(db);
    expect(typeof stop).toBe('function');
    const sched = listSchedulers().schedulers.find((s) => s.name === 'commons_signal_bridge');
    expect(sched?.armed).toBe(true);
    expect(() => stop!()).not.toThrow();
  });

  it('the stop function is idempotent and clears the timers without throwing', () => {
    process.env.COMMONS_SIGNAL_BRIDGE_MODE = 'on';
    const stop = startSignalBridge(db)!;
    expect(() => { stop(); stop(); }).not.toThrow();
  });
});
