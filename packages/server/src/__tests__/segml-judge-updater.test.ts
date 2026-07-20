import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SegmlJudgeUpdater } from '../services/segml-judge-updater';

describe('SegmlJudgeUpdater', () => {
  let db: Database;
  let updater: SegmlJudgeUpdater;

  beforeEach(() => {
    db = new Database(':memory:');
    updater = new SegmlJudgeUpdater(db);
  });

  it('starts with no rubric weights', () => {
    const weights = updater.getRubricWeights();
    expect(Object.keys(weights).length).toBe(0);
  });

  it('increases weight for declining low-scoring categories', () => {
    const result = updater.updateRubricsFromPatterns([
      { category: 'injection', avgScore: 1.5, caseCount: 6, trend: 'declining' },
    ], 5);
    expect(result.rubrics_updated).toBe(1);
    expect(result.updates[0].new_weight).toBeGreaterThan(result.updates[0].previous_weight);
  });

  it('does not update with insufficient evidence', () => {
    const result = updater.updateRubricsFromPatterns([
      { category: 'injection', avgScore: 1.5, caseCount: 2, trend: 'declining' },
    ], 5);
    expect(result.rubrics_updated).toBe(0);
  });

  it('decreases weight for high-scoring improving categories', () => {
    updater.updateRubricsFromPatterns([
      { category: 'canary', avgScore: 4.5, caseCount: 6, trend: 'improving' },
    ], 5);
    const weights = updater.getRubricWeights();
    expect(weights['canary']).toBeLessThan(1.0);
  });

  it('applies rubric weights to scores', () => {
    updater.updateRubricsFromPatterns([
      { category: 'injection', avgScore: 1.0, caseCount: 8, trend: 'declining' },
    ], 5);
    const weights = updater.getRubricWeights();
    const adjusted = updater.applyToScore('injection', 2.0);
    expect(adjusted).toBeCloseTo(2.0 * weights['injection'], 1);
  });

  it('caps weight at 2.0 maximum', () => {
    for (let i = 0; i < 5; i++) {
      updater.updateRubricsFromPatterns([
        { category: 'injection', avgScore: 1.0, caseCount: 10, trend: 'declining' },
      ], 5);
    }
    const weights = updater.getRubricWeights();
    expect(weights['injection']).toBeLessThanOrEqual(2.0);
  });

  it('does not modify weight for stable categories', () => {
    const result = updater.updateRubricsFromPatterns([
      { category: 'contradiction', avgScore: 3.0, caseCount: 6, trend: 'stable' },
    ], 5);
    expect(result.rubrics_updated).toBe(0);
  });
});
