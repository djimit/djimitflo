import { describe, expect, it } from 'vitest';
import { isSpeciesOutcome } from '../services/skill-evolution-engine';

describe('skill-evolution-engine exports (isSpeciesOutcome)', () => {
  describe('isSpeciesOutcome', () => {
    it('returns true for a loop-maker lane id', () => {
      expect(isSpeciesOutcome('loop-maker:lane:abc')).toBe(true);
    });

    it('returns true for a loop-maker gym id', () => {
      expect(isSpeciesOutcome('loop-maker:gym:def')).toBe(true);
    });

    it('returns true for a loop-maker merge id', () => {
      expect(isSpeciesOutcome('loop-maker:merge:ghi')).toBe(true);
    });

    it('returns true for a repo-scoped loop-maker id', () => {
      expect(isSpeciesOutcome('[repo:my-slug:]loop-maker:lane:xyz')).toBe(true);
    });

    it('returns true for an agent: prefixed id', () => {
      expect(isSpeciesOutcome('agent:council-orchestrator')).toBe(true);
    });

    it('returns true for a falsifier: prefixed id', () => {
      expect(isSpeciesOutcome('falsifier:checker-1')).toBe(true);
    });

    it('returns false for a plain delivered skill id', () => {
      expect(isSpeciesOutcome('skill:writer-42')).toBe(false);
    });

    it('returns false for an empty string', () => {
      expect(isSpeciesOutcome('')).toBe(false);
    });

    it('returns false for an id that merely contains "agent" without the prefix', () => {
      expect(isSpeciesOutcome('skill:agent-helper')).toBe(false);
    });

    it('returns false for an id that merely contains "falsifier" without the prefix', () => {
      expect(isSpeciesOutcome('skill:falsifier-tool')).toBe(false);
    });

    it('returns false for an id that merely contains "loop-maker" without the colon-delimited segment', () => {
      expect(isSpeciesOutcome('skill:loop-maker-clone')).toBe(false);
    });
  });
});