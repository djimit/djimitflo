import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { MemoryCandidateService } from '../services/memory-candidate-service';

let db: Database.Database;
let svc: MemoryCandidateService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  svc = new MemoryCandidateService(db);
});

afterEach(() => { db?.close(); });

describe('G8: Memory store formalization', () => {
  it('defaults operational_memory to the episodic store', () => {
    const c = svc.create({
      title: 'Run summary for proof X',
      content: 'The run completed with 4 leases and 3 claims.',
      memory_type: 'operational_memory',
    });
    expect(c.store).toBe('episodic');
  });

  it('defaults engineering_rule to the procedural store', () => {
    const c = svc.create({
      title: 'TypeScript null guard rule',
      content: 'When fixing type errors in loop-service, check for missing null guards on metadata objects.',
      memory_type: 'engineering_rule',
    });
    expect(c.store).toBe('procedural');
  });

  it('defaults policy_rule to the semantic store', () => {
    const c = svc.create({
      title: 'No auto-merge policy',
      content: 'The swarm must never merge or push without human approval.',
      memory_type: 'policy_rule',
    });
    expect(c.store).toBe('semantic');
  });

  it('accepts an explicit store override (distilled rule → procedural)', () => {
    const c = svc.create({
      title: 'Actionable rule: check null guards',
      content: 'When a maker fails on TypeScript type errors, the first check should be null guards on metadata.',
      memory_type: 'operational_memory',
      store: 'procedural',
    });
    expect(c.store).toBe('procedural');
  });

  it('rejects an invalid store', () => {
    expect(() => svc.create({
      title: 'Bad store',
      content: 'This should fail.',
      memory_type: 'operational_memory',
      store: 'invalid_store' as any,
    })).toThrow('MEMORY_CANDIDATE_STORE_INVALID');
  });

  it('persists and retrieves the store field', () => {
    const c = svc.create({
      title: 'Procedural rule for debugging',
      content: 'When debugging a codex maker failure, check the exit code first, then the diff.',
      memory_type: 'engineering_rule',
    });
    const retrieved = svc.get(c.id);
    expect(retrieved.store).toBe('procedural');
  });

  it('the store column exists in the database after migration', () => {
    const cols = db.prepare('PRAGMA table_info(memory_candidates)').all() as Array<{ name: string }>;
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('store');
  });
});
