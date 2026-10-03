import { describe, expect, it } from 'vitest';
import { isAiPaper } from '../services/expert-evidence-enrichment-service';
import type { ArxivPaper } from '../services/knowledge-adapters/arxiv-adapter';

const paper = (categories: string[], primary_category: string | null = null): Pick<ArxivPaper, 'categories' | 'primary_category'> => ({
  categories,
  primary_category,
});

describe('expert-evidence-enrichment-service exports — isAiPaper', () => {
  it('returns true when any category is AI-adjacent', () => {
    expect(isAiPaper(paper(['cs.AI', 'math.PR']))).toBe(true);
  });

  it('returns true when only the primary category is AI-adjacent', () => {
    expect(isAiPaper(paper(['math.PR'], 'cs.LG'))).toBe(true);
  });

  it('returns false for non-AI categories', () => {
    expect(isAiPaper(paper(['math.PR', 'physics.optics'], 'physics.optics'))).toBe(false);
  });

  it('returns false when primary category is null and no AI categories', () => {
    expect(isAiPaper(paper(['math.PR'], null))).toBe(false);
  });

  it('returns true for AI topic labels via the topic regex', () => {
    expect(isAiPaper(paper(['Artificial Intelligence']))).toBe(true);
    expect(isAiPaper(paper(['Machine Learning']))).toBe(true);
    expect(isAiPaper(paper(['Natural Language Processing']))).toBe(true);
  });

  it('returns false for empty categories and null primary', () => {
    expect(isAiPaper(paper([], null))).toBe(false);
  });

  it('returns true when categories include stat.ML', () => {
    expect(isAiPaper(paper(['stat.ML']))).toBe(true);
  });
});