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

describe('leaseIdentity (stamped at dispatch)', () => {
  it('derives provider and family from the requested model, else the runtime default; never rewrites model', () => {
    expect(leaseIdentity('opencode', 'ollama/glm-5.2:cloud', 'p')).toMatchObject({ model_id: 'ollama/glm-5.2:cloud', provider: 'ollama', model_family: 'glm' });
    expect(leaseIdentity('remote', 'workstation/atomic@llama-router', 'p')).toMatchObject({ provider: 'workstation', model_family: 'llama' });
    expect(leaseIdentity('opencode', undefined, 'p', { DJIMITFLO_OPENCODE_MODEL: 'ollama/kimi-k3:cloud' })).toMatchObject({ provider: 'ollama', model_family: 'kimi' });
    expect(leaseIdentity('codex', undefined, 'p', {})).toMatchObject({ model_id: 'codex:default', provider: 'codex', model_family: 'codex' });
    expect(leaseIdentity('opencode', 'm', 'p')).not.toHaveProperty('model');
    expect(leaseIdentity('opencode', 'm', 'a').prompt_hash).not.toBe(leaseIdentity('opencode', 'm', 'b').prompt_hash);
  });

  it('a same-model maker and checker stamped this way are flagged as correlated (was UNDETERMINED without the fields)', () => {
    const svc = new ReviewerIndependenceService(db);
    const maker = { id: 'm', runtime: 'opencode', metadata: leaseIdentity('opencode', 'ollama/glm-5.2:cloud', 'make') };
    const checker = { id: 'c', runtime: 'opencode', metadata: leaseIdentity('opencode', 'ollama/glm-5.2:cloud', 'check') };
    expect(svc.assess(maker, checker, 'r')).toMatchObject({ state: 'FAIL', correlated_fields: ['model_family_independence', 'provider_independence'] });
  });
});

describe('ReviewerIndependenceService', () => {
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
    const checker = Object.fromEntries(Object.entries(independent).map(([key, value]) => [key, `${value}-checker`]));
    expect(new ReviewerIndependenceService(db).assess(
      { id: 'maker', metadata: independent }, { id: 'checker', metadata: checker }, 'loop-1',
    )).toMatchObject({ state: 'PASS', risk: 'low', correlated_fields: [], unknown_fields: [] });
  });

  it('keeps missing identity evidence undetermined rather than passing it', () => {
    expect(new ReviewerIndependenceService(db).assess(
      { id: 'maker', metadata: {} }, { id: 'checker', metadata: {} }, 'loop-1',
    )).toMatchObject({ state: 'UNDETERMINED', risk: 'medium' });
  });

  it('does not treat mock reviewers as independent production evidence', () => {
    const checker = Object.fromEntries(Object.entries(independent).map(([key, value]) => [key, `${value}-checker`]));
    expect(new ReviewerIndependenceService(db).assess(
      { id: 'maker', runtime: 'opencode', metadata: independent },
      { id: 'checker', runtime: 'mock', metadata: checker },
      'loop-1',
    )).toMatchObject({ state: 'UNDETERMINED', risk: 'medium' });
  });
});
