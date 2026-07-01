import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { RsiSafetyGuard } from '../services/rsi-safety-guard';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let guard: RsiSafetyGuard;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  guard = new RsiSafetyGuard(db);
});

afterEach(() => {
  db?.close();
});

describe('G105: RSI Safety Guard', () => {
  it('allows mutations within budget', () => {
    const result = guard.canMutate('loop-service');
    expect(result.allowed).toBe(true);
  });

  it('freezes security components', () => {
    expect(guard.isFrozen('auth-service')).toBe(true);
    expect(guard.isFrozen('authorization-service')).toBe(true);
    expect(guard.isFrozen('audit-service')).toBe(true);
    expect(guard.isFrozen('rate-limiter')).toBe(true);
  });

  it('does not freeze regular components', () => {
    expect(guard.isFrozen('loop-service')).toBe(false);
    expect(guard.isFrozen('goal-decomposer')).toBe(false);
  });

  it('blocks frozen components', () => {
    const result = guard.canMutate('auth-service');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('frozen');
  });

  it('enforces daily mutation budget', () => {
    for (let i = 0; i < 5; i++) {
      guard.logAction('mutation', 'test-component', { iteration: i });
    }

    const result = guard.canMutate('test-component');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('budget');
  });

  it('logs actions to audit log', () => {
    guard.logAction('test-action', 'test-component', { key: 'value' }, 'test-actor');

    const log = guard.getAuditLog(10);
    expect(log.length).toBe(1);
    expect(log[0].action).toBe('test-action');
    expect(log[0].actor).toBe('test-actor');
  });

  it('gets status', () => {
    const status = guard.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.mutationsLimit).toBe(5);
    expect(status.frozenComponents.length).toBeGreaterThan(0);
  });

  it('disables via kill switch', () => {
    guard.setEnabled(false);
    const result = guard.canMutate('loop-service');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('disabled');
  });

  it('re-enables via kill switch', () => {
    guard.setEnabled(false);
    guard.setEnabled(true);
    const result = guard.canMutate('loop-service');
    expect(result.allowed).toBe(true);
  });

  it('audit log preserves all entries', () => {
    guard.logAction('action-1', 'comp-1', {}, 'actor-1');
    guard.logAction('action-2', 'comp-2', {}, 'actor-2');

    const log = guard.getAuditLog(10);
    expect(log.length).toBe(2);
    const actions = log.map(l => l.action).sort();
    expect(actions).toEqual(['action-1', 'action-2']);
  });

  it('counts today mutations only', () => {
    guard.logAction('mutation', 'comp', {});
    guard.logAction('other', 'comp', {});

    const status = guard.getStatus();
    expect(status.mutationsToday).toBe(1);
  });
});
