import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/test-db';
import type { Database } from 'better-sqlite3';
import { LoopRunQueryService } from '../services/loop-run-query-service';

describe('LoopRunQueryService', () => {
  let db: Database;
  let service: LoopRunQueryService;

  beforeEach(() => {
    db = createTestDb() as unknown as Database;
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE IF NOT EXISTS loop_runs (
        id TEXT PRIMARY KEY,
        goal_id TEXT,
        loop_name TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'closed',
        status TEXT NOT NULL DEFAULT 'created',
        repository_path TEXT,
        state_file TEXT,
        findings_json TEXT NOT NULL DEFAULT '[]',
        plan_json TEXT NOT NULL DEFAULT '{}',
        gates_json TEXT NOT NULL DEFAULT '[]',
        next_actions_json TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );
    `);
    service = new LoopRunQueryService(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedRun(id: string, overrides: Record<string, unknown> = {}) {
    db.prepare(`
      INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, repository_path, findings_json, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      overrides.goal_id || null,
      overrides.loop_name || 'test-loop',
      overrides.mode || 'closed',
      overrides.status || 'created',
      overrides.repository_path || null,
      JSON.stringify(overrides.findings || []),
      JSON.stringify(overrides.metadata || {}),
      overrides.created_at || new Date().toISOString(),
    );
  }

  it('gets a run by ID', () => {
    seedRun('run-1', { status: 'running' });

    const run = service.getById('run-1');
    expect(run.id).toBe('run-1');
    expect(run.status).toBe('running');
  });

  it('throws when run not found', () => {
    expect(() => service.getById('nonexistent')).toThrow('LOOP_RUN_NOT_FOUND');
  });

  it('lists all runs', () => {
    seedRun('run-1');
    seedRun('run-2');
    seedRun('run-3');

    const runs = service.list();
    expect(runs).toHaveLength(3);
  });

  it('lists runs with status filter', () => {
    seedRun('run-1', { status: 'running' });
    seedRun('run-2', { status: 'completed' });
    seedRun('run-3', { status: 'running' });

    const running = service.list({ status: 'running' });
    expect(running).toHaveLength(2);
  });

  it('lists runs with goal_id filter', () => {
    seedRun('run-1', { goal_id: 'goal-a' });
    seedRun('run-2', { goal_id: 'goal-b' });
    seedRun('run-3', { goal_id: 'goal-a' });

    const goalARuns = service.list({ goal_id: 'goal-a' });
    expect(goalARuns).toHaveLength(2);
  });

  it('gets active runs', () => {
    seedRun('run-1', { status: 'running' });
    seedRun('run-2', { status: 'verifying' });
    seedRun('run-3', { status: 'planning' });
    seedRun('run-4', { status: 'completed' });

    const active = service.getActive();
    expect(active).toHaveLength(3);
  });

  it('gets interrupted runs', () => {
    seedRun('run-1', { status: 'interrupted' });
    seedRun('run-2', { status: 'interrupted' });
    seedRun('run-3', { status: 'running' });

    const interrupted = service.getInterrupted();
    expect(interrupted).toHaveLength(2);
  });

  it('gets runs by goal ID', () => {
    seedRun('run-1', { goal_id: 'goal-x' });
    seedRun('run-2', { goal_id: 'goal-x' });
    seedRun('run-3', { goal_id: 'goal-y' });

    const runs = service.getByGoalId('goal-x');
    expect(runs).toHaveLength(2);
  });

  it('counts runs', () => {
    seedRun('run-1', { status: 'running' });
    seedRun('run-2', { status: 'running' });
    seedRun('run-3', { status: 'completed' });

    expect(service.count()).toBe(3);
    expect(service.count({ status: 'running' })).toBe(2);
    expect(service.count({ goal_id: 'nonexistent' })).toBe(0);
  });

  it('checks existence', () => {
    seedRun('run-1');

    expect(service.exists('run-1')).toBe(true);
    expect(service.exists('nonexistent')).toBe(false);
  });

  it('gets latest run by name', () => {
    seedRun('run-1', { loop_name: 'doc-drift' });
    seedRun('run-2', { loop_name: 'doc-drift' });

    const latest = service.getLatestByName('doc-drift');
    expect(latest).not.toBeNull();
    expect(latest!.loop_name).toBe('doc-drift');
  });

  it('returns null for latest when no runs exist', () => {
    const latest = service.getLatestByName('nonexistent');
    expect(latest).toBeNull();
  });

  it('respects limit and offset', () => {
    for (let i = 0; i < 10; i++) {
      seedRun(`run-${i}`);
    }

    const page1 = service.list({ limit: 3, offset: 0 });
    expect(page1).toHaveLength(3);

    const page2 = service.list({ limit: 3, offset: 3 });
    expect(page2).toHaveLength(3);
  });

  it('parses findings correctly', () => {
    seedRun('run-1', { findings: [{ id: 'f1', type: 'doc_drift' }] });

    const run = service.getById('run-1');
    expect(run.findings).toHaveLength(1);
    expect(run.findings[0].id).toBe('f1');
  });

  it('parses metadata correctly', () => {
    seedRun('run-1', { metadata: { key: 'value', nested: { a: 1 } } });

    const run = service.getById('run-1');
    expect(run.metadata).toEqual({ key: 'value', nested: { a: 1 } });
  });
});
