import { describe, it, expect, beforeEach } from 'vitest';
import { dimsMatch, embeddingDimMismatch, resetEmbeddingDimMismatch } from '../services/embedding-dims';

describe('embedding-dims exports', () => {
  beforeEach(() => {
    resetEmbeddingDimMismatch();
  });

  describe('dimsMatch', () => {
    it('returns true when expected equals got', () => {
      expect(dimsMatch('vector-memory', 768, 768)).toBe(true);
    });

    it('returns false and does not count when dims match', () => {
      dimsMatch('vector-memory', 768, 768);
      expect(embeddingDimMismatch()).toEqual({});
    });

    it('returns false when expected differs from got', () => {
      expect(dimsMatch('vector-memory', 768, 384)).toBe(false);
    });

    it('counts each mismatch for the store', () => {
      dimsMatch('vector-memory', 768, 384);
      dimsMatch('vector-memory', 768, 384);
      dimsMatch('proposal-dedupe', 2048, 768);
      expect(embeddingDimMismatch()).toEqual({ 'vector-memory': 2, 'proposal-dedupe': 1 });
    });

    it('increments independently per store', () => {
      dimsMatch('a', 1, 2);
      dimsMatch('b', 1, 2);
      dimsMatch('a', 1, 2);
      expect(embeddingDimMismatch()).toEqual({ a: 2, b: 1 });
    });

    it('does not count a match even after prior mismatches', () => {
      dimsMatch('vector-memory', 768, 384);
      dimsMatch('vector-memory', 768, 768);
      expect(embeddingDimMismatch()).toEqual({ 'vector-memory': 1 });
    });
  });

  describe('resetEmbeddingDimMismatch', () => {
    it('clears all mismatch counts', () => {
      dimsMatch('vector-memory', 768, 384);
      expect(embeddingDimMismatch()).toEqual({ 'vector-memory': 1 });
      resetEmbeddingDimMismatch();
      expect(embeddingDimMismatch()).toEqual({});
    });
  });

  describe('embeddingDimMismatch', () => {
    it('returns an empty record when no mismatches recorded', () => {
      expect(embeddingDimMismatch()).toEqual({});
    });
  });
});