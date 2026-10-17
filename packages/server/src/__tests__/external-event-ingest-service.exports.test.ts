import { describe, expect, it } from 'vitest';
import { listField } from '../services/external-event-ingest-service';

describe('external-event-ingest-service exports — listField', () => {
  it('returns the array when given a native array of strings', () => {
    expect(listField(['a.ts', 'b.ts'])).toEqual(['a.ts', 'b.ts']);
  });

  it('decodes a JSON string array delivered by the Redis bus', () => {
    expect(listField('["a.ts","b.ts"]')).toEqual(['a.ts', 'b.ts']);
  });

  it('returns an empty array for a malformed JSON string starting with [', () => {
    expect(listField('[not json')).toEqual([]);
  });

  it('returns an empty array for a non-array JSON string', () => {
    expect(listField('"hello"')).toEqual([]);
  });

  it('returns an empty array for a plain non-JSON string', () => {
    expect(listField('hello')).toEqual([]);
  });

  it('returns an empty array for non-string non-array input', () => {
    expect(listField(42)).toEqual([]);
    expect(listField(null)).toEqual([]);
    expect(listField(undefined)).toEqual([]);
    expect(listField({})).toEqual([]);
  });

  it('filters null and undefined entries and coerces the rest to strings', () => {
    expect(listField(['a', null, undefined, 3, true])).toEqual(['a', '3', 'true']);
  });

  it('decodes a JSON array containing null entries and filters them', () => {
    expect(listField('["a.ts", null, "b.ts"]')).toEqual(['a.ts', 'b.ts']);
  });

  it('returns an empty array for an empty array input', () => {
    expect(listField([])).toEqual([]);
  });

  it('returns an empty array for an empty JSON array string', () => {
    expect(listField('[]')).toEqual([]);
  });

  it('ignores leading/trailing whitespace around a JSON array string', () => {
    expect(listField('  ["a.ts"]  ')).toEqual(['a.ts']);
  });
});