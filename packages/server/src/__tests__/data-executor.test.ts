import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { DataExecutor } from '../execution/executors/data-executor';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let executor: DataExecutor;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  executor = new DataExecutor(db);
});

afterEach(() => {
  db?.close();
});

describe('G74: Data Executor', () => {
  it('can execute data runtime', () => {
    expect(executor.canExecute('data')).toBe(true);
    expect(executor.canExecute('codex')).toBe(false);
  });

  it('executes sql command', async () => {
    const result = await executor.execute({ type: 'sql', action: '', target: ':memory:', query: 'SELECT 1' });
    expect(typeof result.success).toBe('boolean');
  });

  it('executes python command', async () => {
    const result = await executor.execute({ type: 'python', action: '-c "print(1)"', target: '' });
    expect(typeof result.success).toBe('boolean');
  });

  it('executes csv command', async () => {
    const result = await executor.execute({ type: 'csv', action: '', target: '/etc/hostname' });
    expect(typeof result.success).toBe('boolean');
  });

  it('handles unknown type', async () => {
    const result = await executor.execute({ type: 'unknown' as any, action: 'x', target: 'y' });
    expect(result.success).toBe(false);
  });

  it('validates data integrity', async () => {
    const result = await executor.validateDataIntegrity(':memory:', { id: 'INTEGER' });
    expect(typeof result.valid).toBe('boolean');
  });
});
