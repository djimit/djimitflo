import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { MemoryCandidateService } from '../services/memory-candidate-service';

/**
 * I12 (memory fail-closed): upsertToSwarmMemory must return a structured result,
 * never silently swallow. Sink-down, env-disable, and unpromoted candidates all
 * produce `{ ok: false, reason }` so callers can flag memory_flywheel_degraded.
 */
describe('I12: memory flywheel fail-closed', () => {
  let db: Database.Database;
  let svc: MemoryCandidateService;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    svc = new MemoryCandidateService(db);
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    db?.close();
  });

  it('returns ok:false with reason when flywheel is disabled via env', async () => {
    process.env.PROOF_RUN_MEMORY_FLYWHEEL = 'false';
    const c = svc.create({
      title: 'test',
      content: 'test content',
      memory_type: 'operational_memory',
    });
    svc.promote(c.id, { approved_by: 'test' });
    const result = await svc.upsertToSwarmMemory(c.id);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('flywheel_disabled_by_env');
  });

  it('returns ok:false with reason when candidate is not promoted', async () => {
    delete process.env.PROOF_RUN_MEMORY_FLYWHEEL;
    const c = svc.create({
      title: 'unpromoted',
      content: 'not yet promoted',
      memory_type: 'operational_memory',
    });
    const result = await svc.upsertToSwarmMemory(c.id);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('candidate_not_found_or_not_promoted');
  });

  it('returns ok:false with reason when candidate id does not exist', async () => {
    delete process.env.PROOF_RUN_MEMORY_FLYWHEEL;
    const result = await svc.upsertToSwarmMemory('nonexistent-id');
    expect(result.ok).toBe(false);
    // get() throws MEMORY_CANDIDATE_NOT_FOUND, which the try/catch wraps as exception:<msg>
    expect(result.reason).toMatch(/^exception:/);
    expect(result.reason).toContain('MEMORY_CANDIDATE_NOT_FOUND');
  });

  it('surfaces network failure reason without throwing', async () => {
    delete process.env.PROOF_RUN_MEMORY_FLYWHEEL;
    process.env.OLLAMA_URL = 'http://127.0.0.1:1'; // unreachable
    process.env.QDRANT_URL = 'http://127.0.0.1:1';
    const c = svc.create({
      title: 'sink down',
      content: 'sink is unreachable',
      memory_type: 'operational_memory',
    });
    svc.promote(c.id, { approved_by: 'test' });
    const result = await svc.upsertToSwarmMemory(c.id);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
    expect(typeof result.reason).toBe('string');
    expect(result.reason!.length).toBeGreaterThan(0);
  }, 15000);
});
