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
    expect(result.reason).toBeUndefined();
  });

  it('allows mutations one below the limit', () => {
    for (let i = 0; i < 4; i++) {
      guard.logAction('mutation', 'test-component', { iteration: i });
    }
    const result = guard.canMutate('test-component');
    expect(result.allowed).toBe(true);
  });

  it('freezes all security components', () => {
    expect(guard.isFrozen('auth-service')).toBe(true);
    expect(guard.isFrozen('authorization-service')).toBe(true);
    expect(guard.isFrozen('audit-service')).toBe(true);
    expect(guard.isFrozen('rate-limiter')).toBe(true);
    expect(guard.isFrozen('security-scanning-agent')).toBe(true);
  });

  it('does not freeze regular components', () => {
    expect(guard.isFrozen('loop-service')).toBe(false);
    expect(guard.isFrozen('goal-decomposer')).toBe(false);
  });

  it('isFrozen matches when component name contains a frozen name', () => {
    expect(guard.isFrozen('my-auth-service-v2')).toBe(true);
    expect(guard.isFrozen('external-audit-service-module')).toBe(true);
    expect(guard.isFrozen('custom-rate-limiter-v3')).toBe(true);
  });

  it('isFrozen matches when frozen name contains the component name', () => {
    expect(guard.isFrozen('auth')).toBe(true);
    expect(guard.isFrozen('rate')).toBe(true);
    expect(guard.isFrozen('audit')).toBe(true);
    expect(guard.isFrozen('authorization')).toBe(true);
  });

  it('blocks frozen components with component name in reason', () => {
    const result = guard.canMutate('auth-service');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('frozen');
    expect(result.reason).toContain('auth-service');
  });

  it('enforces daily mutation budget at exactly the limit', () => {
    for (let i = 0; i < 5; i++) {
      guard.logAction('mutation', 'test-component', { iteration: i });
    }
    const result = guard.canMutate('test-component');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('budget');
  });

  it('enforces daily mutation budget above the limit', () => {
    for (let i = 0; i < 6; i++) {
      guard.logAction('mutation', 'test-component', { iteration: i });
    }
    const result = guard.canMutate('test-component');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('budget');
  });

  it('budget reason includes count and limit', () => {
    for (let i = 0; i < 5; i++) {
      guard.logAction('mutation', 'test-component', {});
    }
    const result = guard.canMutate('test-component');
    expect(result.reason).toContain('5/5');
  });

  it('logs actions to audit log with all fields', () => {
    guard.logAction('test-action', 'test-component', { key: 'value', nested: { a: 1 } }, 'test-actor');
    const log = guard.getAuditLog(10);
    expect(log.length).toBe(1);
    expect(log[0].action).toBe('test-action');
    expect(log[0].component).toBe('test-component');
    expect(log[0].actor).toBe('test-actor');
    expect(log[0].details).toEqual({ key: 'value', nested: { a: 1 } });
    expect(log[0].id).toMatch(/^audit-/);
    expect(typeof log[0].timestamp).toBe('string');
  });

  it('logAction uses system as default actor', () => {
    guard.logAction('test-action', 'test-component', {});
    const log = guard.getAuditLog(10);
    expect(log[0].actor).toBe('system');
  });

  it('logAction defaults details to empty object', () => {
    guard.logAction('test-action', 'test-component');
    const log = guard.getAuditLog(10);
    expect(log[0].details).toEqual({});
  });

  it('getAuditLog returns all entries with limit', () => {
    guard.logAction('first', 'comp', {});
    guard.logAction('second', 'comp', {});
    guard.logAction('third', 'comp', {});
    const log = guard.getAuditLog(10);
    expect(log.length).toBe(3);
    const actions = log.map(l => l.action).sort();
    expect(actions).toEqual(['first', 'second', 'third']);
  });

  it('getAuditLog respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      guard.logAction(`action-${i}`, 'comp', {});
    }
    const log = guard.getAuditLog(3);
    expect(log.length).toBe(3);
  });

  it('getAuditLog returns empty array when no entries', () => {
    const log = guard.getAuditLog(10);
    expect(log).toEqual([]);
  });

  it('getAuditLog uses default limit of 50 when no argument given', () => {
    for (let i = 0; i < 55; i++) {
      guard.logAction(`action-${i}`, 'comp', {});
    }
    const log = guard.getAuditLog();
    expect(log.length).toBe(50);
  });

  it('gets full status with all fields', () => {
    const status = guard.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.mutationsToday).toBe(0);
    expect(status.mutationsLimit).toBe(5);
    expect(status.lastMutation).toBeNull();
    expect(status.auditLogEntries).toBe(0);
    expect(status.frozenComponents).toEqual([
      'auth-service', 'authorization-service', 'audit-service', 'rate-limiter', 'security-scanning-agent',
    ]);
  });

  it('status frozenComponents is a defensive copy', () => {
    const status = guard.getStatus();
    status.frozenComponents.push('injected');
    status.frozenComponents.splice(0, 1);
    const status2 = guard.getStatus();
    expect(status2.frozenComponents).not.toContain('injected');
    expect(status2.frozenComponents).toContain('auth-service');
  });

  it('status reflects mutations and audit entries', () => {
    guard.logAction('mutation', 'comp', { step: 1 });
    guard.logAction('mutation', 'comp', { step: 2 });
    guard.logAction('review', 'comp', {});
    const status = guard.getStatus();
    expect(status.mutationsToday).toBe(2);
    expect(status.auditLogEntries).toBe(3);
    expect(typeof status.lastMutation).toBe('string');
    expect(status.lastMutation).not.toBeNull();
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

  it('disabled takes priority over frozen', () => {
    guard.setEnabled(false);
    const result = guard.canMutate('auth-service');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('disabled');
    expect(result.reason).not.toContain('frozen');
  });

  it('frozen takes priority over budget', () => {
    for (let i = 0; i < 5; i++) {
      guard.logAction('mutation', 'comp', {});
    }
    const result = guard.canMutate('auth-service');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('frozen');
    expect(result.reason).not.toContain('budget');
  });

  it('setEnabled logs kill_switch action with enabled=false', () => {
    guard.setEnabled(false, 'admin');
    const log = guard.getAuditLog(10);
    expect(log.length).toBe(1);
    expect(log[0].action).toBe('kill_switch');
    expect(log[0].component).toBe('rsi-safety-guard');
    expect(log[0].actor).toBe('admin');
    expect(log[0].details).toEqual({ enabled: false });
  });

  it('setEnabled logs kill_switch action with enabled=true', () => {
    guard.setEnabled(true, 'admin');
    const log = guard.getAuditLog(10);
    expect(log[0].details).toEqual({ enabled: true });
  });

  it('setEnabled default actor is system', () => {
    guard.setEnabled(false);
    const log = guard.getAuditLog(10);
    expect(log[0].actor).toBe('system');
  });

  it('counts today mutations only', () => {
    guard.logAction('mutation', 'comp', {});
    guard.logAction('other', 'comp', {});
    const status = guard.getStatus();
    expect(status.mutationsToday).toBe(1);
  });

  it('audit log preserves all entries', () => {
    guard.logAction('action-1', 'comp-1', {}, 'actor-1');
    guard.logAction('action-2', 'comp-2', {}, 'actor-2');
    const log = guard.getAuditLog(10);
    expect(log.length).toBe(2);
    const actions = log.map(l => l.action).sort();
    expect(actions).toEqual(['action-1', 'action-2']);
  });
});