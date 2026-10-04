import { describe, expect, it } from 'vitest';
import { DEFS, isLocalShadowJudgment } from '../services/local-shadow-queue';

describe('local-shadow-queue exports', () => {
  const knownIds = [
    'checker_second_opinion',
    'commons_contribution',
    'commons_idea',
    'discovery_relevance',
    'failure_cause',
    'proposal_prescreen',
    'reflection_triage',
  ];

  describe('isLocalShadowJudgment', () => {
    it('returns true for every registered shadow judgment id', () => {
      for (const id of knownIds) {
        expect(isLocalShadowJudgment(id)).toBe(true);
      }
    });

    it('returns false for an unknown judgment id', () => {
      expect(isLocalShadowJudgment('kb_passage_relevance')).toBe(false);
    });

    it('returns false for an empty string', () => {
      expect(isLocalShadowJudgment('')).toBe(false);
    });

    it('is case-sensitive', () => {
      expect(isLocalShadowJudgment('Checker_Second_Opinion')).toBe(false);
    });
  });

  describe('DEFS', () => {
    it('maps every known judgment id to a definition', () => {
      for (const id of knownIds) {
        expect(DEFS.has(id)).toBe(true);
        expect(DEFS.get(id)).toBeDefined();
      }
    });

    it('has exactly the known set of judgment ids', () => {
      expect(Array.from(DEFS.keys()).sort()).toEqual([...knownIds].sort());
    });
  });
});