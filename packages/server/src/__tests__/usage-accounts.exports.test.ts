import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { loadRecords, windowStarts, type UsageRecord } from '../services/usage-accounts';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const makeDb = () => new Database(':memory:');

const withCallTable = (db: Database.Database) => db.exec(`CREATE TABLE llm_model_calls (
  consumer TEXT, model TEXT, provider TEXT, ok INTEGER, tokens_in INTEGER, tokens_out INTEGER,
  status TEXT, purpose TEXT, cost_basis TEXT, list_price_cost REAL, created_at TEXT)`);

const withLeaseTable = (db: Database.Database) => db.exec(`CREATE TABLE worker_leases (
  role TEXT, runtime TEXT, status TEXT, created_at TEXT, loop_run_id TEXT, metadata TEXT);
  CREATE TABLE loop_runs (id TEXT PRIMARY KEY, loop_name TEXT)`);

const insertCall = (db: Database.Database, o: Partial<{
  consumer: string; model: string; provider: string | null; ok: number; tokens_in: number | null;
  tokens_out: number | null; status: string | null; purpose: string | null; cost_basis: string | null;
  list_price_cost: number | null; created_at: string;
}>) => db.prepare(`INSERT INTO llm_model_calls
  (consumer, model, provider, ok, tokens_in, tokens_out, status, purpose, cost_basis, list_price_cost, created_at)
  VALUES (@consumer, @model, @provider, @ok, @tokens_in, @tokens_out, @status, @purpose, @cost_basis, @list_price_cost, @created_at)`)
  .run({ consumer: 'cli', model: 'claude-sonar', provider: 'subscription-cli:claude', ok: 1, tokens_in: 100, tokens_out: 50,
    status: null, purpose: null, cost_basis: null, list_price_cost: null, created_at: iso(NOW - HOUR), ...o });

const insertLease = (db: Database.Database, o: Partial<{
  role: string; runtime: string; status: string; created_at: string; loop_run_id: string | null; metadata: Record<string, unknown>;
}>) => db.prepare(`INSERT INTO worker_leases (role, runtime, status, created_at, loop_run_id, metadata)
  VALUES (@role, @runtime, @status, @created_at, @loop_run_id, @metadata)`)
  .run({ role: 'maker', runtime: 'claude', status: 'done', created_at: iso(NOW - HOUR), loop_run_id: null,
    metadata: {}, ...o, metadata: JSON.stringify({ ...(o.metadata ?? {}) }) });

describe('windowStarts', () => {
  it('returns UTC calendar boundaries for today/month and rolling offsets for 5h/7d', () => {
    const s = windowStarts(NOW);
    expect(s['5h']).toBe(NOW - 5 * HOUR);
    expect(s.today).toBe(Date.UTC(2026, 9, 25));
    expect(s['7d']).toBe(NOW - 7 * 86_400_000);
    expect(s.month).toBe(Date.UTC(2026, 9, 1));
  });

  it('rolls today/month at the UTC midnight / month-start boundary', () => {
    const midnight = Date.parse('2026-10-01T00:00:00Z');
    const s = windowStarts(midnight);
    expect(s.today).toBe(midnight);
    expect(s.month).toBe(Date.UTC(2026, 9, 1));
    const lastDay = Date.parse('2026-10-31T23:59:59Z');
    const s2 = windowStarts(lastDay);
    expect(s2.today).toBe(Date.UTC(2026, 9, 31));
    expect(s2.month).toBe(Date.UTC(2026, 9, 1));
  });

  it('exposes exactly the four windows', () => {
    expect(Object.keys(windowStarts(NOW)).sort()).toEqual(['5h', '7d', 'month', 'today']);
  });
});

describe('loadRecords', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => db.close());

  it('marks both sources missing when neither table exists (fail-soft, no throw)', () => {
    const { records, sources } = loadRecords(db, '2026-10-24');
    expect(records).toEqual([]);
    expect(sources).toEqual({ llm_model_calls: 'missing', worker_leases: 'missing' });
  });

  it('returns ok sources and no records when the tables are empty', () => {
    withCallTable(db); withLeaseTable(db);
    const { records, sources } = loadRecords(db, '2026-10-24');
    expect(records).toEqual([]);
    expect(sources).toEqual({ llm_model_calls: 'ok', worker_leases: 'ok' });
  });

  it('maps llm_model_calls rows to accounts, sums tokens, and flags mirror consumer=maker', () => {
    withCallTable(db); withLeaseTable(db);
    insertCall(db, { provider: 'subscription-cli:claude', model: 'claude-x', tokens_in: 100, tokens_out: 50, created_at: iso(NOW - HOUR) });
    insertCall(db, { consumer: 'maker', provider: 'ollama', model: 'llama3:cloud', tokens_in: null, tokens_out: null, created_at: iso(NOW - 2 * HOUR) });
    const { records, sources } = loadRecords(db, '2026-10-24');
    expect(sources).toEqual({ llm_model_calls: 'ok', worker_leases: 'ok' });
    const claude = records.find((r) => r.account === 'claude_max')!;
    expect(claude.tokens).toBe(150);
    expect(claude.ok).toBe(true);
    expect(claude.mirror).toBe(false);
    const mirror = records.find((r) => r.account === 'ollama_cloud')!;
    expect(mirror.mirror).toBe(true);
    expect(mirror.tokens).toBe(null);
  });

  it('flags limit_hit on failed calls with a subscription_limit status', () => {
    withCallTable(db); withLeaseTable(db);
    insertCall(db, { provider: 'free-tier-cli:opencode', model: 'opencode/x', ok: 0, status: 'subscription_limit', created_at: iso(NOW - HOUR) });
    const { records } = loadRecords(db, '2026-10-24');
    const r = records.find((x) => x.account === 'opencode_free')!;
    expect(r.ok).toBe(false);
    expect(r.limit_hit).toBe(true);
    expect(r.error).toBe('subscription_limit');
  });

  it('skips mock/manual leases and maps claude leases with subscription_auth to claude_max', () => {
    withCallTable(db); withLeaseTable(db);
    insertLease(db, { runtime: 'mock', metadata: { token_accounting: { total_tokens: 10 } } });
    insertLease(db, { runtime: 'manual', metadata: {} });
    insertLease(db, { runtime: 'claude', metadata: { subscription_auth: 'ok', token_accounting: { total_tokens: 200, model_id: 'claude-x' } } });
    insertLease(db, { runtime: 'claude', metadata: { token_accounting: { total_tokens: 5 } } });
    const { records } = loadRecords(db, '2026-10-24');
    const accounts = records.map((r) => r.account);
    expect(accounts).toContain('claude_max');
    expect(accounts).toContain('other');
    expect(accounts).not.toContain('mock');
    const sub = records.find((r) => r.account === 'claude_max')!;
    expect(sub.tokens).toBe(200);
    expect(sub.consumer.startsWith('lease:maker:')).toBe(true);
    expect(sub.provider).toBe('lease:claude');
  });

  it('filters out rows before the since prefix', () => {
    withCallTable(db); withLeaseTable(db);
    insertCall(db, { created_at: '2026-10-20T00:00:00Z' });
    insertCall(db, { created_at: iso(NOW - HOUR) });
    const { records } = loadRecords(db, '2026-10-24');
    expect(records.length).toBe(1);
  });
});