import { afterEach, describe, expect, it } from 'vitest';
import {
  GROUNDING_REQUIRED_SOURCES,
  assessGrounding,
  groundingRequired,
} from '../services/proposal-grounding';

describe('proposal-grounding', () => {
  describe('GROUNDING_REQUIRED_SOURCES', () => {
    it('flags reflection and gap_analysis as required sources', () => {
      expect(GROUNDING_REQUIRED_SOURCES.has('reflection')).toBe(true);
      expect(GROUNDING_REQUIRED_SOURCES.has('gap_analysis')).toBe(true);
    });

    it('does not flag other sources as required', () => {
      expect(GROUNDING_REQUIRED_SOURCES.has('observation')).toBe(false);
      expect(GROUNDING_REQUIRED_SOURCES.size).toBe(2);
    });
  });

  describe('groundingRequired', () => {
    const prev = process.env.PROPOSAL_GROUNDING_REQUIRED;
    afterEach(() => {
      if (prev === undefined) delete process.env.PROPOSAL_GROUNDING_REQUIRED;
      else process.env.PROPOSAL_GROUNDING_REQUIRED = prev;
    });

    it('returns true when PROPOSAL_GROUNDING_REQUIRED is true', () => {
      process.env.PROPOSAL_GROUNDING_REQUIRED = 'true';
      expect(groundingRequired()).toBe(true);
    });

    it('returns false when PROPOSAL_GROUNDING_REQUIRED is unset', () => {
      delete process.env.PROPOSAL_GROUNDING_REQUIRED;
      expect(groundingRequired()).toBe(false);
    });

    it('returns false when PROPOSAL_GROUNDING_REQUIRED is any other value', () => {
      process.env.PROPOSAL_GROUNDING_REQUIRED = 'false';
      expect(groundingRequired()).toBe(false);
    });
  });

  describe('assessGrounding', () => {
    it('returns null when no evidence refs are provided', () => {
      expect(
        assessGrounding({ description: 'fix x', rationale: 'because', evidenceRefs: [] }),
      ).toBeNull();
    });

    it('returns null when evidenceRefs is undefined', () => {
      expect(assessGrounding({ description: 'fix x', rationale: 'because' })).toBeNull();
    });

    it('returns explicit grounding when target provided, derived false', () => {
      const result = assessGrounding({
        description: 'desc',
        rationale: 'why',
        evidenceRefs: ['ref-1'],
        grounding: {
          target: 'packages/server/src/foo.ts',
          acceptanceTest: 'npx vitest run',
          baselineMetric: '0%',
          runtimeCommand: 'node foo',
          artifactPath: 'out.txt',
          budget: '5m',
        },
      });
      expect(result).toEqual({
        target: 'packages/server/src/foo.ts',
        acceptanceTest: 'npx vitest run',
        baselineMetric: '0%',
        runtimeCommand: 'node foo',
        artifactPath: 'out.txt',
        budget: '5m',
        derived: false,
      });
    });

    it('trims explicit target', () => {
      const result = assessGrounding({
        description: '',
        rationale: '',
        evidenceRefs: ['r'],
        grounding: { target: '  packages/x  ' },
      });
      expect(result).toEqual({ target: 'packages/x', derived: false });
    });

    it('ignores whitespace-only explicit target and falls through to derivation', () => {
      const result = assessGrounding({
        description: 'see packages/server/src/main.ts',
        rationale: 'reason',
        evidenceRefs: ['r'],
        grounding: { target: '   ' },
      });
      expect(result).toEqual({ target: 'packages/server/src/main.ts', derived: true });
    });

    it('derives target from a repo path in description', () => {
      const result = assessGrounding({
        description: 'Improve packages/server/src/services/redos-guard.ts coverage',
        rationale: 'no test',
        evidenceRefs: ['ref-1'],
      });
      expect(result).toEqual({ target: 'packages/server/src/services/redos-guard.ts', derived: true });
    });

    it('derives target from a repo path in rationale', () => {
      const result = assessGrounding({
        description: 'no path here',
        rationale: 'fix scripts/build.sh',
        evidenceRefs: ['ref-1'],
      });
      expect(result).toEqual({ target: 'scripts/build.sh', derived: true });
    });

    it('returns null when no explicit target and no repo path found', () => {
      expect(
        assessGrounding({
          description: 'improve readability',
          rationale: 'hard to follow',
          evidenceRefs: ['ref-1'],
        }),
      ).toBeNull();
    });

    it('returns only target and derived for derived grounding (no optional fields)', () => {
      const result = assessGrounding({
        description: 'see docs/architecture.md',
        rationale: 'x',
        evidenceRefs: ['r'],
      });
      expect(result).toEqual({ target: 'docs/architecture.md', derived: true });
      expect(result).not.toHaveProperty('acceptanceTest');
    });
  });
});