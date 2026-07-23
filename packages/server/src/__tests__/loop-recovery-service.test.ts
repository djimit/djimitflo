import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/test-db';
import type { Database } from 'better-sqlite3';
import { WorkerLeaseRepo } from '../services/loop-worker-lease-repo';
import { LoopRecoveryService } from '../services/loop-recovery-service';

describe('WorkerLeaseRepo', () => {
  let db: Database;
  let repo: WorkerLeaseRepo;

  beforeEach(() => {
    db = createTestDb() as unknown as Database;
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE IF NOT EXISTS loop_runs (
        id TEXT PRIMARY KEY, goal_id TEXT, loop_name TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'closed',
        status TEXT NOT NULL DEFAULT 'created', repository_path TEXT, state_file TEXT,
        findings_json TEXT NOT NULL DEFAULT '[]', plan_json TEXT NOT NULL DEFAULT '{}',
        gates_json TEXT NOT NULL DEFAULT '[]', next_actions_json TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS worker_leases (
        id TEXT PRIMARY KEY, loop_run_id TEXT NOT NULL REFERENCES loop_runs(id) ON DELETE CASCADE,
        role TEXT NOT NULL, runtime TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'prepared',
        finding_id TEXT, worktree_path TEXT, branch_name TEXT, budget_json TEXT NOT NULL DEFAULT '{}',
        metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')), parent_lease_id TEXT,
        spawn_tree_id TEXT, depth INTEGER NOT NULL DEFAULT 0, spawned_by_agent_id TEXT
      );
    `);
    repo = new WorkerLeaseRepo(db);
  });

  afterEach(() => { db.close(); });

  function seedRun(id: string) {
    db.prepare('INSERT INTO loop_runs (id, loop_name, mode, status) VALUES (?, ?, ?, ?)').run(id, 'test', 'closed', 'running');
  }

  it('inserts a lease', () => {
    seedRun('run-1');
    repo.insert({ id: 'lease-1', loopRunId: 'run-1', role: 'maker', runtime: 'codex', findingId: 'f1', worktreePath: null, branchName: null, metadata: {}, now: new Date().toISOString() });
    const lease = repo.getById('lease-1');
    expect(lease.id).toBe('lease-1');
    expect(lease.status).toBe('prepared');
  });

  it('updates status', () => {
    seedRun('run-1');
    repo.insert({ id: 'lease-1', loopRunId: 'run-1', role: 'maker', runtime: 'codex', findingId: 'f1', worktreePath: null, branchName: null, metadata: {}, now: new Date().toISOString() });
    repo.updateStatus('lease-1', 'running');
    expect(repo.getById('lease-1').status).toBe('running');
  });

  it('updates runtime', () => {
    seedRun('run-1');
    repo.insert({ id: 'lease-1', loopRunId: 'run-1', role: 'maker', runtime: 'codex', findingId: 'f1', worktreePath: null, branchName: null, metadata: {}, now: new Date().toISOString() });
    repo.updateRuntime('lease-1', 'claude');
    expect(repo.getById('lease-1').runtime).toBe('claude');
  });

  it('patches metadata', () => {
    seedRun('run-1');
    repo.insert({ id: 'lease-1', loopRunId: 'run-1', role: 'maker', runtime: 'codex', findingId: 'f1', worktreePath: null, branchName: null, metadata: { key: 'old' }, now: new Date().toISOString() });
    repo.patchMetadata('lease-1', { key: 'new', extra: 'value' });
    const lease = repo.getById('lease-1');
    expect(lease.metadata).toEqual({ key: 'new', extra: 'value' });
  });

  it('lists by loop run', () => {
    seedRun('run-1');
    repo.insert({ id: 'lease-1', loopRunId: 'run-1', role: 'maker', runtime: 'codex', findingId: 'f1', worktreePath: null, branchName: null, metadata: {}, now: new Date().toISOString() });
    repo.insert({ id: 'lease-2', loopRunId: 'run-1', role: 'checker', runtime: 'codex', findingId: 'f1', worktreePath: null, branchName: null, metadata: {}, now: new Date().toISOString() });
    expect(repo.listByLoopRun('run-1')).toHaveLength(2);
  });

  it('gets running leases', () => {
    seedRun('run-1');
    repo.insert({ id: 'lease-1', loopRunId: 'run-1', role: 'maker', runtime: 'codex', findingId: 'f1', worktreePath: null, branchName: null, metadata: {}, now: new Date().toISOString() });
    repo.updateStatus('lease-1', 'running');
    expect(repo.getRunning()).toHaveLength(1);
  });

  it('counts leases', () => {
    seedRun('run-1');
    repo.insert({ id: 'lease-1', loopRunId: 'run-1', role: 'maker', runtime: 'codex', findingId: 'f1', worktreePath: null, branchName: null, metadata: {}, now: new Date().toISOString() });
    repo.insert({ id: 'lease-2', loopRunId: 'run-1', role: 'checker', runtime: 'codex', findingId: 'f1', worktreePath: null, branchName: null, metadata: {}, now: new Date().toISOString() });
    expect(repo.count({ loop_run_id: 'run-1' })).toBe(2);
  });

  it('checks cancellation', () => {
    seedRun('run-1');
    repo.insert({ id: 'lease-1', loopRunId: 'run-1', role: 'maker', runtime: 'codex', findingId: 'f1', worktreePath: null, branchName: null, metadata: {}, now: new Date().toISOString() });
    expect(repo.isCancelled('lease-1')).toBe(false);
    repo.updateStatus('lease-1', 'cancelled');
    expect(repo.isCancelled('lease-1')).toBe(true);
  });

  it('deletes by loop run', () => {
    seedRun('run-1');
    repo.insert({ id: 'lease-1', loopRunId: 'run-1', role: 'maker', runtime: 'codex', findingId: 'f1', worktreePath: null, branchName: null, metadata: {}, now: new Date().toISOString() });
    expect(repo.deleteByLoopRun('run-1')).toBe(1);
    expect(repo.count({ loop_run_id: 'run-1' })).toBe(0);
  });

  it('throws on missing lease', () => {
    expect(() => repo.getById('nonexistent')).toThrow('MAKER_LEASE_NOT_FOUND');
  });
});

describe('LoopRecoveryService', () => {
  let db: Database;
  let service: LoopRecoveryService;

  beforeEach(() => {
    db = createTestDb() as unknown as Database;
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE IF NOT EXISTS loop_runs (
        id TEXT PRIMARY KEY, goal_id TEXT, loop_name TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'closed',
        status TEXT NOT NULL DEFAULT 'created', repository_path TEXT, state_file TEXT,
        findings_json TEXT NOT NULL DEFAULT '[]', plan_json TEXT NOT NULL DEFAULT '{}',
        gates_json TEXT NOT NULL DEFAULT '[]', next_actions_json TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS worker_leases (
        id TEXT PRIMARY KEY, loop_run_id TEXT NOT NULL REFERENCES loop_runs(id) ON DELETE CASCADE,
        role TEXT NOT NULL, runtime TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'prepared',
        finding_id TEXT, worktree_path TEXT, branch_name TEXT, budget_json TEXT NOT NULL DEFAULT '{}',
        metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')), parent_lease_id TEXT,
        spawn_tree_id TEXT, depth INTEGER NOT NULL DEFAULT 0, spawned_by_agent_id TEXT
      );
    `);
    service = new LoopRecoveryService(db);
  });

  afterEach(() => { db.close(); });

  function seedRun(id: string, status = 'running') {
    db.prepare('INSERT INTO loop_runs (id, loop_name, mode, status) VALUES (?, ?, ?, ?)').run(id, 'test', 'closed', status);
  }

  it('recovers interrupted runs', () => {
    seedRun('run-1', 'running');
    const result = service.recoverInterruptedRuns();
    expect(result.interruptedRuns).toBe(1);
  });

  it('resumes interrupted run', () => {
    seedRun('run-1', 'interrupted');
    const result = service.resumeInterruptedRun('run-1');
    expect(result.resumed).toBe(true);
  });

  it('fails after max resume attempts', () => {
    seedRun('run-1', 'interrupted');
    const result = service.resumeInterruptedRun('run-1', 0); // max 0 attempts
    expect(result.boundedFail).toBe(true);
    expect(result.resumed).toBe(false);
  });

  it('throws on non-interrupted run', () => {
    seedRun('run-1', 'running');
    expect(() => service.resumeInterruptedRun('run-1')).toThrow('LOOP_RUN_NOT_INTERRUPTED');
  });

  it('resumes all interrupted runs', () => {
    seedRun('run-1', 'interrupted');
    seedRun('run-2', 'interrupted');
    const result = service.resumeInterruptedRuns();
    expect(result.resumed).toBe(2);
  });
});
