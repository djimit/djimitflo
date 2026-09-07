import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { ReviewerIndependenceService } from '../services/reviewer-independence-service';
import { createTestDb } from './helpers/test-db';

let db: Database.Database;
beforeEach(() => { db = createTestDb(); });
afterEach(() => db.close());

const independent = {
  model_family: 'family-a', provider: 'provider-a', system_prompt_hash: 'prompt-a', context_hash: 'context-a',
  memory_hash: 'memory-a', retrieval_hash: 'retrieval-a', oracle_hash: 'oracle-a',
};

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
});
