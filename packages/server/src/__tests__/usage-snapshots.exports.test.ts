import { expect, it, beforeEach, afterEach, describe } from 'vitest';
import Database from 'better-sqlite3';
import { recordSnapshot, latestSnapshots, snapshotLimitReached, SNAPSHOT_STALE_HOURS, type LatestSnapshot } from '../services/usage-snapshots';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const HOUR = 3_600_000;
const ago = (h: number) => new Date(NOW - h * HOUR).toISOString();
const ahead = (h: number) => new Date(NOW + h * HOUR).toISOString();

// latestSnapshots reads only account_usage_snapshots; an in-memory db with that
// single table (or none at all) is enough to exercise every branch. The query
// is fail-soft: a missing table yields an empty Map, never an error.
const makeDb = (withTable = true) => {
  const db = new Database(':memory:');
  if (withTable) {
    db.exec(`CREATE TABLE account_usage_snapshots (
      id TEXT PRIMARY KEY, account TEXT NOT NULL, reported_at TEXT NOT NULL, reported_by TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'operator_snapshot', payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`);
  }
  return db;
};

describe('latestSnapshots', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => db.close());

  it('returns an empty Map when the table is missing (fail-soft, no error)', () => {
    const d = makeDb(false);
    expect(latestSnapshots(d, NOW).size).toBe(0);
    d.close();
  });

  it('returns one entry per account: the latest by reported_at, with age and stale flag', () => {
    recordSnapshot(db, 'claude_max', 'u1', { weekly: { used_pct: 40 } }, ago(30));
    recordSnapshot(db, 'claude_max', 'u1', { weekly: { used_pct: 55 }, plan: 'Max 5x' }, ago(3));
    recordSnapshot(db, 'chatgpt_pro', 'u1', { session: { used_pct: 12 } }, ago(26));
    const m = latestSnapshots(db, NOW);
    expect([...m.keys()]).toEqual(['chatgpt_pro', 'claude_max']);
    const claude = m.get('claude_max')!;
    expect(claude.reported_at).toBe(ago(3));
    expect(claude.age_hours).toBe(3);
    expect(claude.stale).toBe(false);
    expect(claude.payload).toEqual({ weekly: { used_pct: 55 }, plan: 'Max 5x' });
    const codex = m.get('chatgpt_pro')!;
    expect(codex.age_hours).toBe(26);
    expect(codex.stale).toBe(true); // > SNAPSHOT_STALE_HOURS
  });

  it('rounds age_hours to one decimal and marks stale exactly past SNAPSHOT_STALE_HOURS', () => {
    recordSnapshot(db, 'claude_max', 'u1', { weekly: { used_pct: 1 } }, ago(2.55));
    const s = latestSnapshots(db, NOW).get('claude_max')!;
    expect(s.age_hours).toBe(2.6);
    // boundary: exactly 24 h old is NOT stale (ageH > 24 is strict)
    recordSnapshot(db, 'chatgpt_pro', 'u1', { weekly: { used_pct: 1 } }, ago(SNAPSHOT_STALE_HOURS));
    expect(latestSnapshots(db, NOW).get('chatgpt_pro')!.stale).toBe(false);
    recordSnapshot(db, 'nvidia', 'u1', { weekly: { used_pct: 1 } }, ago(SNAPSHOT_STALE_HOURS + 0.01));
    expect(latestSnapshots(db, NOW).get('nvidia')!.stale).toBe(true);
  });

  it('skips rows whose payload_json is unparseable or fails the schema (no entry, no throw)', () => {
    db.prepare('INSERT INTO account_usage_snapshots (id, account, reported_at, reported_by, payload_json) VALUES (?, ?, ?, ?, ?)')
      .run('bad-json', 'claude_max', ago(1), 'u1', '{not json');
    db.prepare('INSERT INTO account_usage_snapshots (id, account, reported_at, reported_by, payload_json) VALUES (?, ?, ?, ?, ?)')
      .run('bad-schema', 'claude_max', ago(1), 'u1', JSON.stringify({ session: { used_pct: 999 } }));
    db.prepare('INSERT INTO account_usage_snapshots (id, account, reported_at, reported_by, payload_json) VALUES (?, ?, ?, ?, ?)')
      .run('ok', 'claude_max', ago(1), 'u1', JSON.stringify({ weekly: { used_pct: 10 } }));
    const m = latestSnapshots(db, NOW);
    expect(m.size).toBe(1);
    expect(m.get('claude_max')!.payload).toEqual({ weekly: { used_pct: 10 } });
  });

  it('keeps only the newest row per account when several share the same reported_at (tie-break by rowid DESC)', () => {
    recordSnapshot(db, 'claude_max', 'u1', { weekly: { used_pct: 1 } }, ago(2));
    recordSnapshot(db, 'claude_max', 'u1', { weekly: { used_pct: 2 } }, ago(2));
    recordSnapshot(db, 'claude_max', 'u1', { weekly: { used_pct: 3 } }, ago(2));
    expect(latestSnapshots(db, NOW).get('claude_max')!.payload).toEqual({ weekly: { used_pct: 3 } });
  });
});

describe('snapshotLimitReached', () => {
  const snap = (o: Partial<LatestSnapshot>): LatestSnapshot => ({
    reported_at: ago(1), stale: false, age_hours: 1,
    payload: { session: { used_pct: 100, resets_at: ahead(2) }, weekly: { used_pct: 100, resets_at: ahead(40) } },
    ...o,
  });

  it('returns null when there is no snapshot, or the snapshot is stale', () => {
    expect(snapshotLimitReached(undefined, NOW)).toBeNull();
    expect(snapshotLimitReached(snap({ stale: true }), NOW)).toBeNull();
  });

  it('returns limit_reached for a fresh session window at >= 100 % that has not reset, with until = resets_at', () => {
    const r = snapshotLimitReached(snap({ payload: { session: { used_pct: 100, resets_at: ahead(3) } } }), NOW);
    expect(r).toMatchObject({ state: 'limit_reached', since: ago(1), until: ahead(3) });
    expect(r!.reason).toMatch(/operator snapshot.*session 100 % used/);
  });

  it('returns null when the only full window has already reset (resets_at in the past)', () => {
    expect(snapshotLimitReached(snap({ payload: { session: { used_pct: 100, resets_at: ago(0.5) }, weekly: { used_pct: 50 } } }), NOW)).toBeNull();
  });

  it('returns null when no window is at or above 100 %', () => {
    expect(snapshotLimitReached(snap({ payload: { session: { used_pct: 99 }, weekly: { used_pct: 99 } } }), NOW)).toBeNull();
  });

  it('skips a window the account API already reports (apiWindows wins), but still flags the other', () => {
    const r = snapshotLimitReached(snap(), NOW, { session: { used_pct: 20 } });
    expect(r).not.toBeNull();
    expect(r!.reason).toMatch(/weekly 100 % used/);
    expect(r!.reason).not.toMatch(/session/);
  });

  it('combines session and weekly full windows and sets until to the latest resets_at', () => {
    const r = snapshotLimitReached(snap({ payload: { session: { used_pct: 100, resets_at: ahead(2) }, weekly: { used_pct: 100, resets_at: ahead(48) } } }), NOW);
    expect(r).toMatchObject({ state: 'limit_reached', until: ahead(48) });
    expect(r!.reason).toMatch(/session 100 % used.*weekly 100 % used/);
  });

  it('sets until = null when a full window has no resets_at', () => {
    const r = snapshotLimitReached(snap({ payload: { weekly: { used_pct: 100 } } }), NOW, { session: {} });
    expect(r).toMatchObject({ state: 'limit_reached', until: null });
  });
});