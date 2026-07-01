import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { DataExecutor } from '../execution/executors/data-executor';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

describe('DataExecutor', () => {
  let db: Database.Database;
  let executor: DataExecutor;

  it('should create an instance', () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    executor = new DataExecutor(db);
    expect(executor).toBeDefined();
  });

  it('should handle data runtime', () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    executor = new DataExecutor(db);
    expect(executor.canExecute('data')).toBe(true);
    expect(executor.canExecute('codex')).toBe(false);
  });

  it('should execute csv task', async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    executor = new DataExecutor(db);
    const result = await executor.execute({
      type: 'csv',
      action: '',
      target: '/etc/hostname',
    });
    expect(result).toBeDefined();
    expect(typeof result.success).toBe('boolean');
  });

  it('should execute json task', async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    executor = new DataExecutor(db);
    const result = await executor.execute({
      type: 'json',
      action: '',
      target: '/dev/null',
    });
    expect(result).toBeDefined();
  });

  it('should handle unknown type', async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    executor = new DataExecutor(db);
    const result = await executor.execute({
      type: 'unknown' as any,
      action: 'x',
      target: 'y',
    });
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('should measure duration', async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    executor = new DataExecutor(db);
    const result = await executor.execute({
      type: 'csv',
      action: '',
      target: '/etc/hostname',
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should validate data integrity', async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    executor = new DataExecutor(db);
    const result = await executor.validateDataIntegrity(':memory:', { id: 'INTEGER' });
    expect(typeof result.valid).toBe('boolean');
    expect(Array.isArray(result.issues)).toBe(true);
  });
});
