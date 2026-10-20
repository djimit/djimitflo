import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { ReviewerIndependenceService, leaseIdentity } from '../services/reviewer-independence-service';
import { createTestDb } from './helpers/test-db';

let db: Database.Database;
beforeEach(() => { db = createTestDb(); });
afterEach(() => db.close());

const independent = {
  model_family: 'family-a', provider: 'provider-a', system_prompt_hash: 'prompt-a', context_hash: 'context-a',
  memory_hash: 'memory-a', retrieval_hash: 'retrieval-a', oracle_hash: 'oracle-a',
};
const different = Object.fromEntries(Object.entries(independent).map(([key, value]) => [key, `${value}-checker`]));

function insertLoopRun(id: string): void {
  db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status) VALUES (?, NULL, ?, 'closed', 'created')`).run(id, id);
}

function insertLease(id: string, loopRunId: string, role: 'maker' | 'checker' | 'planner', runtime: string, metadata: Record<string, unknown>, updatedAt: string): void {
  db.prepare(`
    INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)
  `).run(id, loopRunId, role, runtime, JSON.stringify(metadata), updatedAt, updatedAt);
}

describe('leaseIdentity (stamped at dispatch)', () => {
  it('derives provider and family from the requested model, else the runtime default; never rewrites model', () => {
    expect(leaseIdentity('opencode', 'ollama/glm-5.2:cloud', 'p')).toMatchObject({ model_id: 'ollama/glm-5.2:cloud', provider: 'ollama', model_family: 'glm' });
    expect(leaseIdentity('remote', 'workstation/atomic@llama-router', 'p')).toMatchObject({ provider: 'workstation', model_family: 'llama' });
    expect(leaseIdentity('opencode', undefined, 'p', { DJIMITFLO_OPENCODE_MODEL: 'ollama/kimi-k3:cloud' })).toMatchObject({ provider: 'ollama', model_family: 'kimi' });
    expect(leaseIdentity('codex', undefined, 'p', {})).toMatchObject({ model_id: 'codex:default', provider: 'codex', model_family: 'codex' });
    expect(leaseIdentity('opencode', 'm', 'p')).not.toHaveProperty('model');
    expect(leaseIdentity('opencode', 'm', 'a').prompt_hash).not.toBe(leaseIdentity('opencode', 'm', 'b').prompt_hash);
  });

  it('prefers the requested model over the runtime env default when both are set', () => {
    expect(leaseIdentity('opencode', 'ollama/glm-5.2:cloud', 'p', { DJIMITFLO_OPENCODE_MODEL: 'ollama/kimi-k3:cloud' }))
      .toMatchObject({ model_id: 'ollama/glm-5.2:cloud', provider: 'ollama', model_family: 'glm' });
  });

  it('falls back to the runtime default when the requested model is empty and no env override exists', () => {
    expect(leaseIdentity('kimi', undefined, 'p', {})).toMatchObject({ model_id: 'kimi:default', provider: 'kimi', model_family: 'kimi' });
  });

  it('extracts the family as the first alphabetic run of the base model name', () => {
    expect(leaseIdentity('opencode', 'ollama/glm-5.2:cloud', 'p').model_family).toBe('glm');
    expect(leaseIdentity('remote', 'workstation/atomic@llama-router', 'p').model_family).toBe('llama');
    expect(leaseIdentity('opencode', 'm', 'p').model_family).toBe('m');
  });

  it('stamps a deterministic 16-char sha256 prompt hash', () => {
    const id = leaseIdentity('opencode', 'm', 'prompt-x');
    expect(id.prompt_hash).toHaveLength(16);
    expect(id.prompt_hash).toBe(leaseIdentity('opencode', 'm', 'prompt-x').prompt_hash);
  });

  it('a same-model maker and checker stamped this way are flagged as correlated (was UNDETERMINED without the fields)', () => {
    const svc = new ReviewerIndependenceService(db);
    const maker = { id: 'm', runtime: 'opencode', metadata: leaseIdentity('opencode', 'ollama/glm-5.2:cloud', 'make') };
    const checker = { id: 'c', runtime: 'opencode', metadata: leaseIdentity('opencode', 'ollama/glm-5.2:cloud', 'check') };
    expect(svc.assess(maker, checker, 'r')).toMatchObject({ state: 'FAIL', correlated_fields: ['model_family_independence', 'provider_independence'] });
  });
});

describe('ReviewerIndependenceService.assess dimensions', () => {
  it('flags nominally separate reviewers that share model, prompt, context and memory', () => {
    const service = new ReviewerIndependenceService(db);
    const result = service.assess(
      { id: 'maker', metadata: independent },
      { id: 'checker', metadata: independent },
      'loop-1',
    );
    expect(result.state).toBe('FAIL');
    expect(result.risk).toBe('high');
    expect(result.correlated_fields).toContain('model_family_independence');
    expect(result.correlated_fields).toContain('memory_independence');
  });

  it('passes only when every declared independence dimension differs', () => {
    expect(new ReviewerIndependenceService(db).assess(
      { id: 'maker', metadata: independent }, { id: 'checker', metadata: different }, 'loop-1',
    )).toMatchObject({ state: 'PASS', risk: 'low', correlated_fields: [], unknown_fields: [] });
  });

  it('keeps missing identity evidence undetermined rather than passing it', () => {
    expect(new ReviewerIndependenceService(db).assess(
      { id: 'maker', metadata: {} }, { id: 'checker', metadata: {} }, 'loop-1',
    )).toMatchObject({ state: 'UNDETERMINED', risk: 'medium' });
  });

  it('treats a dimension as unknown when only one side declares it', () => {
    const result = new ReviewerIndependenceService(db).assess(
      { id: 'maker', metadata: { model_family: 'a' } },
      { id: 'checker', metadata: {} },
      'loop-1',
    );
    expect(result.dimensions.model_family_independence).toBeNull();
    expect(result.unknown_fields).toContain('model_family_independence');
    expect(result.correlated_fields).not.toContain('model_family_independence');
  });

  it('fails when some dimensions correlate and the rest are unknown (not all-unknown)', () => {
    const result = new ReviewerIndependenceService(db).assess(
      { id: 'maker', metadata: { model_family: 'a', provider: 'a' } },
      { id: 'checker', metadata: { model_family: 'b', provider: 'a' } },
      'loop-1',
    );
    expect(result.state).toBe('FAIL');
    expect(result.risk).toBe('high');
    expect(result.correlated_fields).toEqual(['provider_independence']);
    expect(result.unknown_fields).not.toContain('provider_independence');
  });

  it('does not treat mock reviewers as independent production evidence', () => {
    expect(new ReviewerIndependenceService(db).assess(
      { id: 'maker', runtime: 'opencode', metadata: independent },
      { id: 'checker', runtime: 'mock', metadata: different },
      'loop-1',
    )).toMatchObject({ state: 'UNDETERMINED', risk: 'medium' });
  });

  it('does not treat manual reviewers as independent production evidence', () => {
    expect(new ReviewerIndependenceService(db).assess(
      { id: 'maker', runtime: 'manual', metadata: independent },
      { id: 'checker', runtime: 'manual', metadata: different },
      'loop-1',
    )).toMatchObject({ state: 'UNDETERMINED', risk: 'medium' });
  });

  it('returns UNDETERMINED with null lease ids when either reviewer is missing', () => {
    const svc = new ReviewerIndependenceService(db);
    expect(svc.assess(null, { id: 'c', metadata: independent }, 'r')).toMatchObject({ state: 'UNDETERMINED', maker_lease_id: null, checker_lease_id: 'c' });
    expect(svc.assess({ id: 'm', metadata: independent }, null, 'r')).toMatchObject({ state: 'UNDETERMINED', maker_lease_id: 'm', checker_lease_id: null });
    expect(svc.assess(null, null, 'r')).toMatchObject({ state: 'UNDETERMINED', maker_lease_id: null, checker_lease_id: null });
  });

  it('derives loop_run_id from the maker or checker lease when omitted', () => {
    const svc = new ReviewerIndependenceService(db);
    expect(svc.assess(
      { id: 'm', loop_run_id: 'from-maker', metadata: independent },
      { id: 'c', loop_run_id: 'from-checker', metadata: different },
    )).toMatchObject({ loop_run_id: 'from-maker' });
    expect(svc.assess(null, { id: 'c', loop_run_id: 'from-checker', metadata: different })).toMatchObject({ loop_run_id: 'from-checker' });
    expect(svc.assess(null, null).loop_run_id).toBe('');
  });
});

describe('ReviewerIndependenceService.identity fallbacks', () => {
  it('falls back through model_family -> model_id -> model for the model dimension', () => {
    expect(new ReviewerIndependenceService(db).assess(
      { id: 'm', metadata: { model: 'x' } }, { id: 'c', metadata: { model: 'x' } }, 'r',
    )).toMatchObject({ dimensions: { model_family_independence: false }, correlated_fields: ['model_family_independence'] });
    expect(new ReviewerIndependenceService(db).assess(
      { id: 'm', metadata: { model_id: 'x' } }, { id: 'c', metadata: { model_id: 'y' } }, 'r',
    )).toMatchObject({ dimensions: { model_family_independence: true } });
  });

  it('falls back through provider -> model_provider for the provider dimension', () => {
    expect(new ReviewerIndependenceService(db).assess(
      { id: 'm', metadata: { model_provider: 'p' } }, { id: 'c', metadata: { model_provider: 'p' } }, 'r',
    )).toMatchObject({ dimensions: { provider_independence: false }, correlated_fields: ['provider_independence'] });
  });

  it('falls back through system_prompt_hash -> prompt_hash for the prompt dimension', () => {
    expect(new ReviewerIndependenceService(db).assess(
      { id: 'm', metadata: { prompt_hash: 'h' } }, { id: 'c', metadata: { prompt_hash: 'h' } }, 'r',
    )).toMatchObject({ dimensions: { prompt_independence: false }, correlated_fields: ['prompt_independence'] });
  });

  it('falls back through memory_hash -> memory_scope_hash for the memory dimension', () => {
    expect(new ReviewerIndependenceService(db).assess(
      { id: 'm', metadata: { memory_scope_hash: 's' } }, { id: 'c', metadata: { memory_scope_hash: 's' } }, 'r',
    )).toMatchObject({ dimensions: { memory_independence: false }, correlated_fields: ['memory_independence'] });
  });

  it('treats whitespace-only identity values as missing', () => {
    const result = new ReviewerIndependenceService(db).assess(
      { id: 'm', metadata: { model_family: '   ' } }, { id: 'c', metadata: { model_family: '   ' } }, 'r',
    );
    expect(result.dimensions.model_family_independence).toBeNull();
    expect(result.unknown_fields).toContain('model_family_independence');
    expect(result.correlated_fields).not.toContain('model_family_independence');
  });
});

describe('ReviewerIndependenceService.object parsing', () => {
  it('parses metadata stored as a JSON string', () => {
    expect(new ReviewerIndependenceService(db).assess(
      { id: 'm', metadata: JSON.stringify(independent) }, { id: 'c', metadata: JSON.stringify(independent) }, 'r',
    )).toMatchObject({ state: 'FAIL' });
  });

  it('treats an array metadata object as empty', () => {
    expect(new ReviewerIndependenceService(db).assess(
      { id: 'm', metadata: [1, 2] as unknown }, { id: 'c', metadata: {} }, 'r',
    )).toMatchObject({ state: 'UNDETERMINED' });
  });

  it('treats a JSON array string as empty', () => {
    expect(new ReviewerIndependenceService(db).assess(
      { id: 'm', metadata: '[1,2]' }, { id: 'c', metadata: '{}' }, 'r',
    )).toMatchObject({ state: 'UNDETERMINED' });
  });

  it('treats invalid JSON as empty', () => {
    expect(new ReviewerIndependenceService(db).assess(
      { id: 'm', metadata: 'not-json' }, { id: 'c', metadata: 'not-json' }, 'r',
    )).toMatchObject({ state: 'UNDETERMINED' });
  });

  it('treats non-string non-object metadata as empty', () => {
    expect(new ReviewerIndependenceService(db).assess(
      { id: 'm', metadata: 42 as unknown }, { id: 'c', metadata: null as unknown }, 'r',
    )).toMatchObject({ state: 'UNDETERMINED' });
  });
});

describe('ReviewerIndependenceService.assessLoop', () => {
  it('reads maker/checker leases from the db and resolves the maker via checker.metadata.maker_lease_id', () => {
    insertLoopRun('loop-2');
    insertLease('m1', 'loop-2', 'maker', 'opencode', independent, '2026-01-01 00:00:00');
    insertLease('c1', 'loop-2', 'checker', 'opencode', { ...different, maker_lease_id: 'm1' }, '2026-01-02 00:00:00');
    expect(new ReviewerIndependenceService(db).assessLoop('loop-2'))
      .toMatchObject({ loop_run_id: 'loop-2', maker_lease_id: 'm1', checker_lease_id: 'c1', state: 'PASS', risk: 'low' });
  });

  it('falls back to the first maker lease when checker metadata lacks maker_lease_id', () => {
    insertLoopRun('loop-3');
    insertLease('m1', 'loop-3', 'maker', 'opencode', independent, '2026-01-01 00:00:00');
    insertLease('c1', 'loop-3', 'checker', 'opencode', different, '2026-01-02 00:00:00');
    expect(new ReviewerIndependenceService(db).assessLoop('loop-3'))
      .toMatchObject({ maker_lease_id: 'm1', checker_lease_id: 'c1', state: 'PASS' });
  });

  it('ignores non-maker/checker leases when resolving reviewers', () => {
    insertLoopRun('loop-4');
    insertLease('p1', 'loop-4', 'planner', 'opencode', independent, '2026-01-01 00:00:00');
    insertLease('m1', 'loop-4', 'maker', 'opencode', independent, '2026-01-02 00:00:00');
    insertLease('c1', 'loop-4', 'checker', 'opencode', different, '2026-01-03 00:00:00');
    expect(new ReviewerIndependenceService(db).assessLoop('loop-4'))
      .toMatchObject({ maker_lease_id: 'm1', checker_lease_id: 'c1' });
  });

  it('returns UNDETERMINED with null lease ids when no maker/checker leases exist', () => {
    insertLoopRun('empty');
    expect(new ReviewerIndependenceService(db).assessLoop('empty'))
      .toMatchObject({ loop_run_id: 'empty', maker_lease_id: null, checker_lease_id: null, state: 'UNDETERMINED' });
  });
});

describe('ReviewerIndependenceService.latest', () => {
  it('orders runs by checker updated_at desc and clamps the limit to [1,100]', () => {
    insertLoopRun('run-a'); insertLoopRun('run-b');
    insertLease('ma', 'run-a', 'maker', 'opencode', independent, '2026-01-01 00:00:00');
    insertLease('ca', 'run-a', 'checker', 'opencode', { ...different, maker_lease_id: 'ma' }, '2026-01-05 00:00:00');
    insertLease('mb', 'run-b', 'maker', 'opencode', independent, '2026-01-02 00:00:00');
    insertLease('cb', 'run-b', 'checker', 'opencode', { ...different, maker_lease_id: 'mb' }, '2026-01-09 00:00:00');
    const svc = new ReviewerIndependenceService(db);
    expect(svc.latest(10).map((r) => r.loop_run_id)).toEqual(['run-b', 'run-a']);
    expect(svc.latest(0)).toHaveLength(1);
    expect(svc.latest(-3)).toHaveLength(1);
  });
});