import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { approvalTtlMs, loopApprovalLink } from '../services/approval-service';

describe('approvalTtlMs', () => {
  it('returns the default 1 h when APPROVAL_TTL_MS is unset', () => {
    expect(approvalTtlMs({})).toBe(3_600_000);
  });

  it('returns the default when APPROVAL_TTL_MS is non-numeric', () => {
    expect(approvalTtlMs({ APPROVAL_TTL_MS: 'abc' })).toBe(3_600_000);
  });

  it('returns the default when APPROVAL_TTL_MS is zero or negative', () => {
    expect(approvalTtlMs({ APPROVAL_TTL_MS: '0' })).toBe(3_600_000);
    expect(approvalTtlMs({ APPROVAL_TTL_MS: '-100' })).toBe(3_600_000);
  });

  it('returns the configured value within the clamp range', () => {
    expect(approvalTtlMs({ APPROVAL_TTL_MS: '7200000' })).toBe(7_200_000);
  });

  it('clamps to the 5 min floor', () => {
    expect(approvalTtlMs({ APPROVAL_TTL_MS: '10000' })).toBe(300_000);
  });

  it('clamps to the 7 day ceiling', () => {
    const sevenDays = 7 * 86_400_000;
    expect(approvalTtlMs({ APPROVAL_TTL_MS: String(sevenDays * 10) })).toBe(sevenDays);
  });
});

describe('loopApprovalLink', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(schema);
    runMigrations(db);
    db.pragma('foreign_keys = OFF');
  });

  afterEach(() => db.close());

  it('returns an empty object when metadata has no loop_run_id', () => {
    expect(loopApprovalLink(db, { metadata: {} })).toEqual({});
  });

  it('returns an empty object when metadata is a JSON string without loop_run_id', () => {
    expect(loopApprovalLink(db, { metadata: JSON.stringify({ foo: 'bar' }) })).toEqual({});
  });

  it('returns loop_run_id and lease_id even when the loop_run row does not exist', () => {
    const link = loopApprovalLink(db, {
      metadata: { loop_run_id: 'run-1', lease_id: 'lease-1' },
    });
    expect(link).toEqual({ loop_run_id: 'run-1', lease_id: 'lease-1' });
  });

  it('joins loop_run → goal to populate goal_id and improvement_id', () => {
    db.prepare(`INSERT INTO goals (id, objective, risk_class, status, improvement_id) VALUES (?, ?, ?, ?, ?)`)
      .run('goal-1', 'obj', 'low', 'created', 'imp-1');
    db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status) VALUES (?, ?, ?, ?, ?)`)
      .run('run-1', 'goal-1', 'test', 'closed', 'running');

    const link = loopApprovalLink(db, {
      metadata: { loop_run_id: 'run-1', lease_id: 'lease-1' },
    });

    expect(link).toEqual({
      loop_run_id: 'run-1',
      lease_id: 'lease-1',
      goal_id: 'goal-1',
      improvement_id: 'imp-1',
    });
  });

  it('omits goal_id when the loop_run has no goal', () => {
    db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status) VALUES (?, ?, ?, ?, ?)`)
      .run('run-2', null, 'test', 'closed', 'running');

    const link = loopApprovalLink(db, {
      metadata: { loop_run_id: 'run-2' },
    });

    expect(link).toEqual({ loop_run_id: 'run-2' });
  });

  it('omits improvement_id when the goal has none', () => {
    db.prepare(`INSERT INTO goals (id, objective, risk_class, status) VALUES (?, ?, ?, ?)`)
      .run('goal-2', 'obj', 'low', 'created');
    db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status) VALUES (?, ?, ?, ?, ?)`)
      .run('run-3', 'goal-2', 'test', 'closed', 'running');

    const link = loopApprovalLink(db, {
      metadata: { loop_run_id: 'run-3' },
    });

    expect(link).toEqual({ loop_run_id: 'run-3', goal_id: 'goal-2' });
  });

  it('parses string metadata containing loop_run_id', () => {
    db.prepare(`INSERT INTO goals (id, objective, risk_class, status, improvement_id) VALUES (?, ?, ?, ?, ?)`)
      .run('goal-3', 'obj', 'low', 'created', 'imp-3');
    db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status) VALUES (?, ?, ?, ?, ?)`)
      .run('run-4', 'goal-3', 'test', 'closed', 'running');

    const link = loopApprovalLink(db, {
      metadata: JSON.stringify({ loop_run_id: 'run-4', lease_id: 'lease-4' }),
    });

    expect(link).toEqual({
      loop_run_id: 'run-4',
      lease_id: 'lease-4',
      goal_id: 'goal-3',
      improvement_id: 'imp-3',
    });
  });

  it('returns an empty object (fail-soft) when metadata is invalid JSON', () => {
    expect(loopApprovalLink(db, { metadata: 'not-json' })).toEqual({});
  });

  it('returns an empty object when metadata is null', () => {
    expect(loopApprovalLink(db, { metadata: null as unknown })).toEqual({});
  });

  it('omits empty-string lease_id', () => {
    db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status) VALUES (?, ?, ?, ?, ?)`)
      .run('run-5', null, 'test', 'closed', 'running');

    const link = loopApprovalLink(db, {
      metadata: { loop_run_id: 'run-5', lease_id: '' },
    });

    expect(link).toEqual({ loop_run_id: 'run-5' });
  });
});