import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { ensurePowerTable, gpuJobs, tokenLedger } from '../services/resource-ledger';

describe('ensurePowerTable', () => {
  it('creates the host_power_samples table on a fresh database', () => {
    const db = new Database(':memory:') as unknown as DB;
    ensurePowerTable(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='host_power_samples'").all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe('host_power_samples');
    db.close();
  });

  it('creates an index on (host, at)', () => {
    const db = new Database(':memory:') as unknown as DB;
    ensurePowerTable(db);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_host_power_samples'").all() as Array<{ name: string }>;
    expect(indexes).toHaveLength(1);
    db.close();
  });

  it('is idempotent — calling twice does not throw or duplicate', () => {
    const db = new Database(':memory:') as unknown as DB;
    expect(() => { ensurePowerTable(db); ensurePowerTable(db); }).not.toThrow();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='host_power_samples'").all();
    expect(tables).toHaveLength(1);
    db.close();
  });
});

describe('gpuJobs', () => {
  it('returns an empty array when no source tables exist (safeAll never throws)', () => {
    const db = new Database(':memory:') as unknown as DB;
    expect(gpuJobs(db, '2026-01-01T00:00:00.000Z', '2026-01-31T00:00:00.000Z')).toEqual([]);
    db.close();
  });

  it('returns gym jobs from loop_runs with a remote_host in the window', () => {
    const db = new Database(':memory:') as unknown as DB;
    db.exec(`CREATE TABLE loop_runs (loop_name TEXT, status TEXT, metadata TEXT, created_at TEXT, completed_at TEXT, updated_at TEXT)`);
    db.prepare(`INSERT INTO loop_runs VALUES (?, ?, ?, ?, ?, ?)`).run(
      'evolution-gym', 'completed',
      JSON.stringify({ gym: { remote_host: 'host-a', species: 'alpha' } }),
      '2026-01-10T00:00:00.000Z', '2026-01-10T01:00:00.000Z', '2026-01-10T01:00:00.000Z',
    );
    const jobs = gpuJobs(db, '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].consumer).toBe('gym:alpha');
    expect(jobs[0].host).toBe('host-a');
    expect(jobs[0].end).toBeGreaterThan(jobs[0].start);
    db.close();
  });

  it('excludes loop_runs outside the time window', () => {
    const db = new Database(':memory:') as unknown as DB;
    db.exec(`CREATE TABLE loop_runs (loop_name TEXT, status TEXT, metadata TEXT, created_at TEXT, completed_at TEXT, updated_at TEXT)`);
    db.prepare(`INSERT INTO loop_runs VALUES (?, ?, ?, ?, ?, ?)`).run(
      'evolution-gym', 'completed',
      JSON.stringify({ gym: { remote_host: 'host-a', species: 'beta' } }),
      '2025-06-10T00:00:00.000Z', '2025-06-10T01:00:00.000Z', '2025-06-10T01:00:00.000Z',
    );
    const jobs = gpuJobs(db, '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
    expect(jobs).toEqual([]);
    db.close();
  });

  it('returns remote maker jobs and committee jobs in the window', () => {
    const db = new Database(':memory:') as unknown as DB;
    db.exec(`CREATE TABLE remote_maker_jobs (host TEXT, species TEXT, claimed_at TEXT, finished_at TEXT)`);
    db.exec(`CREATE TABLE committee_jobs (host TEXT, claimed_at TEXT, finished_at TEXT)`);
    db.prepare(`INSERT INTO remote_maker_jobs VALUES (?, ?, ?, ?)`).run('host-b', 'gamma', '2026-01-11T00:00:00.000Z', '2026-01-11T00:30:00.000Z');
    db.prepare(`INSERT INTO committee_jobs VALUES (?, ?, ?)`).run('host-c', '2026-01-12T00:00:00.000Z', '2026-01-12T00:15:00.000Z');
    const jobs = gpuJobs(db, '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
    expect(jobs).toHaveLength(2);
    const consumers = jobs.map((j) => j.consumer).sort();
    expect(consumers).toEqual(['committee', 'maker:remote@host-b/gamma']);
    db.close();
  });

  it('filters out jobs where end is not greater than start', () => {
    const db = new Database(':memory:') as unknown as DB;
    db.exec(`CREATE TABLE committee_jobs (host TEXT, claimed_at TEXT, finished_at TEXT)`);
    db.prepare(`INSERT INTO committee_jobs VALUES (?, ?, ?)`).run('host-d', '2026-01-12T00:00:00.000Z', '2026-01-12T00:00:00.000Z');
    const jobs = gpuJobs(db, '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
    expect(jobs).toEqual([]);
    db.close();
  });
});

describe('tokenLedger', () => {
  it('returns an empty array when no source tables exist (safeAll never throws)', () => {
    const db = new Database(':memory:') as unknown as DB;
    expect(tokenLedger(db, '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')).toEqual([]);
    db.close();
  });

  it('classifies remote runtime leases as local tokens and others as cloud', () => {
    const db = new Database(':memory:') as unknown as DB;
    db.exec(`CREATE TABLE worker_leases (created_at TEXT, role TEXT, runtime TEXT, metadata TEXT)`);
    db.prepare(`INSERT INTO worker_leases VALUES (?, ?, ?, ?)`).run(
      '2026-01-10T12:00:00.000Z', 'maker', 'remote', JSON.stringify({ model: 'qwen', runtime_usage: { total_tokens: 500 } }),
    );
    db.prepare(`INSERT INTO worker_leases VALUES (?, ?, ?, ?)`).run(
      '2026-01-10T13:00:00.000Z', 'checker', 'opencode', JSON.stringify({ runtime_usage: { total_tokens: 200 } }),
    );
    const rows = tokenLedger(db, '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
    expect(rows).toHaveLength(2);
    const maker = rows.find((r) => r.consumer === 'maker:remote@qwen');
    expect(maker).toBeDefined();
    expect(maker!.local).toBe(500);
    expect(maker!.cloud).toBe(0);
    const reviewer = rows.find((r) => r.consumer === 'reviewer:checker:opencode');
    expect(reviewer).toBeDefined();
    expect(reviewer!.cloud).toBe(200);
    expect(reviewer!.local).toBe(0);
    db.close();
  });

  it('excludes manual runtime leases', () => {
    const db = new Database(':memory:') as unknown as DB;
    db.exec(`CREATE TABLE worker_leases (created_at TEXT, role TEXT, runtime TEXT, metadata TEXT)`);
    db.prepare(`INSERT INTO worker_leases VALUES (?, ?, ?, ?)`).run(
      '2026-01-10T12:00:00.000Z', 'maker', 'manual', JSON.stringify({ runtime_usage: { total_tokens: 999 } }),
    );
    expect(tokenLedger(db, '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')).toEqual([]);
    db.close();
  });

  it('classifies llm_model_calls by isLocalModel and prefixes consumer with llm:', () => {
    const db = new Database(':memory:') as unknown as DB;
    db.exec(`CREATE TABLE llm_model_calls (created_at TEXT, consumer TEXT, model TEXT, provider TEXT, tokens_in INTEGER, tokens_out INTEGER)`);
    db.prepare(`INSERT INTO llm_model_calls VALUES (?, ?, ?, ?, ?, ?)`).run('2026-01-10T10:00:00.000Z', 'agent-1', 'llama3', 'ollama', 100, 50);
    db.prepare(`INSERT INTO llm_model_calls VALUES (?, ?, ?, ?, ?, ?)`).run('2026-01-10T11:00:00.000Z', 'agent-2', 'gpt-4', 'openai', 300, 200);
    const rows = tokenLedger(db, '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
    expect(rows).toHaveLength(2);
    const local = rows.find((r) => r.consumer === 'llm:agent-1');
    expect(local).toBeDefined();
    expect(local!.local).toBe(150);
    expect(local!.cloud).toBe(0);
    const cloud = rows.find((r) => r.consumer === 'llm:agent-2');
    expect(cloud).toBeDefined();
    expect(cloud!.cloud).toBe(500);
    expect(cloud!.local).toBe(0);
    db.close();
  });
});