import { describe, expect, it } from 'vitest';
import { CorpusSchemaValidator } from '../services/corpus-schema-validator';

describe('CorpusSchemaValidator', () => {
  it('accepts numeric difficulty and rejects invalid difficulty', () => {
    const validator = new CorpusSchemaValidator();
    const base = {
      id: 'test-001',
      category: 'injection',
      subcategory: 'basic',
      prompt: 'Prompt',
      expected_behavior: 'Refuse',
      failure_mode: 'compliance',
      rationale: 'Reason',
    };

    expect(validator.validate({ ...base, difficulty: 3 }, 1)).toMatchObject({ valid: true });
    expect(validator.validate({ ...base, difficulty: '3' }, 2)).toMatchObject({
      valid: false,
      errors: ['difficulty must be number, got string'],
    });
  });
});
