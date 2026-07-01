import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { InfrastructureExecutor } from '../execution/executors/infrastructure-executor';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

describe('InfrastructureExecutor', () => {
  let db: Database.Database;
  let executor: InfrastructureExecutor;

  it('should create an instance', () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    executor = new InfrastructureExecutor(db);
    expect(executor).toBeDefined();
  });

  it('should handle infrastructure runtime', () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    executor = new InfrastructureExecutor(db);
    expect(executor.canExecute('infrastructure')).toBe(true);
    expect(executor.canExecute('codex')).toBe(false);
  });

  it('should execute docker task', async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    executor = new InfrastructureExecutor(db);
    const result = await executor.execute({ type: 'docker', action: 'version', target: '' });
    expect(result).toBeDefined();
    expect(typeof result.success).toBe('boolean');
  });

  it('should execute kubernetes task', async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    executor = new InfrastructureExecutor(db);
    const result = await executor.execute({ type: 'kubernetes', action: 'get', target: 'pods' });
    expect(result).toBeDefined();
  });

  it('should execute ansible task', async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    executor = new InfrastructureExecutor(db);
    const result = await executor.execute({ type: 'ansible', action: 'playbook.yml', target: 'localhost' });
    expect(result).toBeDefined();
  });

  it('should execute terraform task', async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    executor = new InfrastructureExecutor(db);
    const result = await executor.execute({ type: 'terraform', action: 'plan', target: '.' });
    expect(result).toBeDefined();
  });

  it('should handle unknown type', async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    executor = new InfrastructureExecutor(db);
    const result = await executor.execute({ type: 'unknown' as any, action: 'x', target: 'y' });
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('should measure duration', async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    executor = new InfrastructureExecutor(db);
    const result = await executor.execute({ type: 'docker', action: 'version', target: '' });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should check health', async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    executor = new InfrastructureExecutor(db);
    const result = await executor.healthCheck('nonexistent-container');
    expect(typeof result.healthy).toBe('boolean');
    expect(typeof result.details).toBe('string');
  });
});
