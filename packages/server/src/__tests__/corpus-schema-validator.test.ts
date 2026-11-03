import { describe, expect, it } from 'vitest';
import { CorpusSchemaValidator } from '../services/corpus-schema-validator';

describe('CorpusSchemaValidator', () => {
  const base = {
    id: 'test-001',
    category: 'injection',
    subcategory: 'basic',
    prompt: 'Prompt',
    expected_behavior: 'Refuse',
    failure_mode: 'compliance',
    rationale: 'Reason',
  };

  describe('validate — happy path', () => {
    it('accepts a fully valid case with numeric difficulty', () => {
      const validator = new CorpusSchemaValidator();
      const r = validator.validate({ ...base, difficulty: 3 }, 1);
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
      expect(r.line).toBe(1);
    });

    it('accepts a valid case with difficulty omitted', () => {
      const validator = new CorpusSchemaValidator();
      const r = validator.validate({ ...base }, 7);
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
    });

    it('accepts difficulty boundary values 1 and 5', () => {
      const validator = new CorpusSchemaValidator();
      expect(validator.validate({ ...base, difficulty: 1 }, 1).valid).toBe(true);
      expect(validator.validate({ ...base, difficulty: 5 }, 2).valid).toBe(true);
    });
  });

  describe('validate — required text fields', () => {
    it('reports every missing required text field on an empty object', () => {
      const validator = new CorpusSchemaValidator();
      const r = validator.validate({}, 3);
      expect(r.valid).toBe(false);
      expect(r.errors).toEqual([
        "Missing/invalid: 'id'",
        "Missing/invalid: 'category'",
        "Missing/invalid: 'subcategory'",
        "Missing/invalid: 'prompt'",
        "Missing/invalid: 'expected_behavior'",
        "Missing/invalid: 'failure_mode'",
        "Missing/invalid: 'rationale'",
      ]);
    });

    it('rejects an empty-string text field', () => {
      const validator = new CorpusSchemaValidator();
      const r = validator.validate({ ...base, category: '' }, 1);
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("Missing/invalid: 'category'");
    });

    it('rejects a whitespace-only text field', () => {
      const validator = new CorpusSchemaValidator();
      const r = validator.validate({ ...base, prompt: '   ' }, 1);
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("Missing/invalid: 'prompt'");
    });

    it('rejects a non-string text field', () => {
      const validator = new CorpusSchemaValidator();
      const r = validator.validate({ ...base, rationale: 42 }, 1);
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("Missing/invalid: 'rationale'");
    });
  });

  describe('validate — difficulty', () => {
    it('rejects a string difficulty with a typeof error', () => {
      const validator = new CorpusSchemaValidator();
      const r = validator.validate({ ...base, difficulty: '3' }, 2);
      expect(r.valid).toBe(false);
      expect(r.errors).toEqual(['difficulty must be number, got string']);
    });

    it('rejects difficulty below 1', () => {
      const validator = new CorpusSchemaValidator();
      const r = validator.validate({ ...base, difficulty: 0 }, 1);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.startsWith('difficulty must be 1-5 int'))).toBe(true);
    });

    it('rejects difficulty above 5', () => {
      const validator = new CorpusSchemaValidator();
      const r = validator.validate({ ...base, difficulty: 6 }, 1);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.startsWith('difficulty must be 1-5 int'))).toBe(true);
    });

    it('rejects a non-integer difficulty', () => {
      const validator = new CorpusSchemaValidator();
      const r = validator.validate({ ...base, difficulty: 2.5 }, 1);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.startsWith('difficulty must be 1-5 int'))).toBe(true);
      expect(r.errors[0]).toContain('2.5');
    });

    it('rejects a boolean difficulty as non-number', () => {
      const validator = new CorpusSchemaValidator();
      const r = validator.validate({ ...base, difficulty: true }, 1);
      expect(r.valid).toBe(false);
      expect(r.errors).toEqual(['difficulty must be number, got boolean']);
    });
  });

  describe('validate — id pattern', () => {
    it('rejects an id with trailing characters after the three digits', () => {
      const validator = new CorpusSchemaValidator();
      const r = validator.validate({ ...base, id: 'test-001x' }, 1);
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("id pattern mismatch: 'test-001x'");
    });

    it('rejects an id with leading characters before the lowercase prefix', () => {
      const validator = new CorpusSchemaValidator();
      const r = validator.validate({ ...base, id: 'Xtest-001' }, 1);
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("id pattern mismatch: 'Xtest-001'");
    });

    it('rejects an id with too few digits', () => {
      const validator = new CorpusSchemaValidator();
      const r = validator.validate({ ...base, id: 'test-01' }, 1);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.startsWith('id pattern mismatch'))).toBe(true);
    });

    it('does not report an id pattern error when id is not a string', () => {
      const validator = new CorpusSchemaValidator();
      const r = validator.validate({ ...base, id: 123 }, 1);
      expect(r.errors.some((e) => e.startsWith('id pattern mismatch'))).toBe(false);
      expect(r.errors).toContain("Missing/invalid: 'id'");
    });
  });

  describe('validateAll', () => {
    it('parses valid lines into the valid bucket and preserves order', () => {
      const validator = new CorpusSchemaValidator();
      const line1 = JSON.stringify({ ...base, difficulty: 2 });
      const line2 = JSON.stringify({ ...base, id: 'auth-010', difficulty: 4 });
      const r = validator.validateAll([line1, line2]);
      expect(r.valid).toHaveLength(2);
      expect(r.valid[0].id).toBe('test-001');
      expect(r.valid[1].id).toBe('auth-010');
      expect(r.invalid).toEqual([]);
    });

    it('skips blank/whitespace-only lines without recording them', () => {
      const validator = new CorpusSchemaValidator();
      const r = validator.validateAll(['', '   ', JSON.stringify({ ...base, difficulty: 1 })]);
      expect(r.valid).toHaveLength(1);
      expect(r.invalid).toEqual([]);
    });

    it('records invalid JSON with a truncated raw and the right line number', () => {
      const validator = new CorpusSchemaValidator();
      const r = validator.validateAll(['{ not json', JSON.stringify({ ...base, difficulty: 1 })]);
      expect(r.valid).toHaveLength(1);
      expect(r.invalid).toHaveLength(1);
      expect(r.invalid[0]).toMatchObject({ valid: false, line: 1, raw: '{ not json' });
      expect(r.invalid[0].errors).toEqual(['Invalid JSON']);
    });

    it('records schema-invalid entries with their line number and truncated raw', () => {
      const validator = new CorpusSchemaValidator();
      const bad = JSON.stringify({ id: 'test-001', category: 'injection' });
      const r = validator.validateAll([bad]);
      expect(r.valid).toEqual([]);
      expect(r.invalid).toHaveLength(1);
      expect(r.invalid[0].valid).toBe(false);
      expect(r.invalid[0].line).toBe(1);
      expect(r.invalid[0].raw).toBe(bad.slice(0, 100));
      expect(r.invalid[0].errors.length).toBeGreaterThan(0);
    });

    it('returns empty buckets for an empty input array', () => {
      const validator = new CorpusSchemaValidator();
      const r = validator.validateAll([]);
      expect(r.valid).toEqual([]);
      expect(r.invalid).toEqual([]);
    });
  });
});
