import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { InfrastructureExecutor } from '../execution/executors/infrastructure-executor';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let executor: InfrastructureExecutor;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  executor = new InfrastructureExecutor(db);
});

afterEach(() => {
  db?.close();
});

describe('G73: Infrastructure Executor', () => {
  it('can execute infrastructure runtime', () => {
    expect(executor.canExecute('infrastructure')).toBe(true);
    expect(executor.canExecute('codex')).toBe(false);
  });

  it('executes docker command', async () => {
    const result = await executor.execute({ type: 'docker', action: 'ps', target: '' });
    expect(typeof result.success).toBe('boolean');
  });

  it('executes kubernetes command', async () => {
    const result = await executor.execute({ type: 'kubernetes', action: 'get', target: 'pods' });
    expect(typeof result.success).toBe('boolean');
  });

  it('handles unknown type', async () => {
    const result = await executor.execute({ type: 'unknown' as any, action: 'x', target: 'y' });
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('measures duration', async () => {
    const result = await executor.execute({ type: 'docker', action: 'version', target: '' });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
