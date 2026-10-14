import { afterEach, describe, expect, it } from 'vitest';
import {
  dimsMatch,
  embeddingDimMismatch,
  resetEmbeddingDimMismatch,
  vectorStrictDim,
} from '../services/embedding-dims';

afterEach(() => {
  resetEmbeddingDimMismatch();
});

describe('vectorStrictDim', () => {
  it('returns false by default when VECTOR_STRICT_DIM is unset', () => {
    expect(vectorStrictDim({})).toBe(false);
  });

  it('returns true only when VECTOR_STRICT_DIM is exactly "true"', () => {
    expect(vectorStrictDim({ VECTOR_STRICT_DIM: 'true' })).toBe(true);
    expect(vectorStrictDim({ VECTOR_STRICT_DIM: 'false' })).toBe(false);
    expect(vectorStrictDim({ VECTOR_STRICT_DIM: '1' })).toBe(false);
  });
});

describe('dimsMatch', () => {
  it('returns true when expected equals got and does not record a mismatch', () => {
    expect(dimsMatch('mem', 768, 768)).toBe(true);
    expect(embeddingDimMismatch()).toEqual({});
  });

  it('returns false and counts a single mismatch for the store', () => {
    expect(dimsMatch('mem', 768, 384)).toBe(false);
    expect(embeddingDimMismatch()).toEqual({ mem: 1 });
  });

  it('accumulates mismatch counts per store independently', () => {
    expect(dimsMatch('mem', 768, 384)).toBe(false);
    expect(dimsMatch('mem', 768, 2048)).toBe(false);
    expect(dimsMatch('prop', 384, 768)).toBe(false);
    expect(embeddingDimMismatch()).toEqual({ mem: 2, prop: 1 });
  });

  it('does not increment the counter on a matching call', () => {
    dimsMatch('mem', 768, 768);
    dimsMatch('mem', 768, 384);
    dimsMatch('mem', 768, 768);
    expect(embeddingDimMismatch()).toEqual({ mem: 1 });
  });
});

describe('embeddingDimMismatch', () => {
  it('returns an empty record before any mismatch is recorded', () => {
    expect(embeddingDimMismatch()).toEqual({});
  });

  it('reflects mismatch counts across multiple stores', () => {
    dimsMatch('a', 1, 2);
    dimsMatch('b', 1, 2);
    dimsMatch('a', 1, 2);
    expect(embeddingDimMismatch()).toEqual({ a: 2, b: 1 });
  });
});

describe('resetEmbeddingDimMismatch', () => {
  it('clears all recorded mismatch counts', () => {
    dimsMatch('mem', 768, 384);
    dimsMatch('prop', 384, 2048);
    expect(Object.keys(embeddingDimMismatch()).length).toBeGreaterThan(0);
    resetEmbeddingDimMismatch();
    expect(embeddingDimMismatch()).toEqual({});
  });
});