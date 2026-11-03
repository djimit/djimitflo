import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopWorkerExecutorService } from '../services/loop-worker-executor-service';

describe('LoopWorkerExecutorService agent assignment', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
  });

  afterEach(() => {
    db?.close();
  });

  function worker(): { resolveAgentId(runtime: string, role: string): string } {
    // loopService is never touched by resolveAgentId(); a stub is fine here.
    return new LoopWorkerExecutorService(db, {} as never) as unknown as { resolveAgentId(runtime: string, role: string): string };
  }

  it('creates a real agents row so loop-worker tasks are not left "Unassigned"', () => {
    const id = worker().resolveAgentId('opencode', 'maker');
    const agent = db.prepare('SELECT name, status, capabilities FROM agents WHERE id = ?').get(id) as
      { name: string; status: string; capabilities: string };
    expect(agent.name).toBe('opencode-maker');
    expect(agent.status).toBe('active');
    expect(JSON.parse(agent.capabilities)).toEqual(['opencode', 'maker']);
  });

  it('is idempotent for the same runtime+role, and distinct per role', () => {
    const w = worker();
    const first = w.resolveAgentId('hermes', 'checker');
    const second = w.resolveAgentId('hermes', 'checker');
    const makerForSameRuntime = w.resolveAgentId('hermes', 'maker');
    expect(second).toBe(first);
    expect(makerForSameRuntime).not.toBe(first);
    expect((db.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number }).n).toBe(2);
  });
});
