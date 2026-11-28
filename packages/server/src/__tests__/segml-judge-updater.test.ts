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
    expect(result.rollback_performed).toBe(false);
  });

  it('records detailed rationale with direction and metrics for declining category', () => {
    const result = updater.updateRubricsFromPatterns([
      { category: 'injection', avgScore: 1.5, caseCount: 6, trend: 'declining' },
    ], 5);
    const r = result.updates[0].rationale;
    expect(r).toContain('increased');
    expect(r).toContain('injection');
    expect(r).toContain('1.50');
    expect(r).toContain('6 cases');
    expect(r).toContain('declining');
  });

  it('does not update with insufficient evidence', () => {
    const result = updater.updateRubricsFromPatterns([
      { category: 'injection', avgScore: 1.5, caseCount: 2, trend: 'declining' },
    ], 5);
    expect(result.rubrics_updated).toBe(0);
  });

  it('updates when caseCount equals minEvidence (boundary)', () => {
    const result = updater.updateRubricsFromPatterns([
      { category: 'injection', avgScore: 1.5, caseCount: 5, trend: 'declining' },
    ], 5);
    expect(result.rubrics_updated).toBe(1);
  });

  it('decreases weight for high-scoring improving categories with exact weight', () => {
    const result = updater.updateRubricsFromPatterns([
      { category: 'canary', avgScore: 4.5, caseCount: 6, trend: 'improving' },
    ], 5);
    expect(result.rubrics_updated).toBe(1);
    expect(result.updates[0].new_weight).toBe(0.95);
    expect(result.updates[0].previous_weight).toBe(1.0);
    const weights = updater.getRubricWeights();
    expect(weights['canary']).toBe(0.95);
    const r = result.updates[0].rationale;
    expect(r).toContain('decreased');
    expect(r).toContain('canary');
    expect(r).toContain('4.50');
    expect(r).toContain('improving');
  });

  it('does not decrease when avgScore is exactly 4.0 and improving', () => {
    const result = updater.updateRubricsFromPatterns([
      { category: 'canary', avgScore: 4.0, caseCount: 6, trend: 'improving' },
    ], 5);
    expect(result.rubrics_updated).toBe(0);
  });

  it('does not decrease when avgScore above 4.0 but trend is stable', () => {
    const result = updater.updateRubricsFromPatterns([
      { category: 'canary', avgScore: 4.5, caseCount: 6, trend: 'stable' },
    ], 5);
    expect(result.rubrics_updated).toBe(0);
  });

  it('does not update when avgScore is between branches and trend improving', () => {
    const result = updater.updateRubricsFromPatterns([
      { category: 'canary', avgScore: 3.0, caseCount: 6, trend: 'improving' },
    ], 5);
    expect(result.rubrics_updated).toBe(0);
  });

  it('increases weight for stable mid-scoring categories by 1.1 factor with exact weight', () => {
    const result = updater.updateRubricsFromPatterns([
      { category: 'contradiction', avgScore: 1.5, caseCount: 6, trend: 'stable' },
    ], 5);
    expect(result.rubrics_updated).toBe(1);
    expect(result.updates[0].new_weight).toBe(1.1);
    expect(result.updates[0].previous_weight).toBe(1.0);
    const r = result.updates[0].rationale;
    expect(r).toContain('increased');
  });

  it('does not update stable branch when avgScore is exactly 2.5', () => {
    const result = updater.updateRubricsFromPatterns([
      { category: 'contradiction', avgScore: 2.5, caseCount: 6, trend: 'stable' },
    ], 5);
    expect(result.rubrics_updated).toBe(0);
  });

  it('does not update when avgScore is exactly 2.0 and declining', () => {
    const result = updater.updateRubricsFromPatterns([
      { category: 'injection', avgScore: 2.0, caseCount: 6, trend: 'declining' },
    ], 5);
    expect(result.rubrics_updated).toBe(0);
  });

  it('does not update when avgScore is 2.2 and declining (between branches)', () => {
    const result = updater.updateRubricsFromPatterns([
      { category: 'injection', avgScore: 2.2, caseCount: 6, trend: 'declining' },
    ], 5);
    expect(result.rubrics_updated).toBe(0);
  });

  it('does not update when avgScore below 2.0 but trend improving', () => {
    const result = updater.updateRubricsFromPatterns([
      { category: 'injection', avgScore: 1.5, caseCount: 6, trend: 'improving' },
    ], 5);
    expect(result.rubrics_updated).toBe(0);
  });

  it('does not modify weight for stable categories with high score', () => {
    const result = updater.updateRubricsFromPatterns([
      { category: 'contradiction', avgScore: 3.0, caseCount: 6, trend: 'stable' },
    ], 5);
    expect(result.rubrics_updated).toBe(0);
  });

  it('applies rubric weights to scores', () => {
    updater.updateRubricsFromPatterns([
      { category: 'injection', avgScore: 1.0, caseCount: 8, trend: 'declining' },
    ], 5);
    const weights = updater.getRubricWeights();
    const adjusted = updater.applyToScore('injection', 2.0);
    expect(adjusted).toBeCloseTo(2.0 * weights['injection'], 1);
  });

  it('returns base score for unknown category in applyToScore', () => {
    expect(updater.applyToScore('unknown', 2.5)).toBe(2.5);
  });

  it('caps weight at 2.0 maximum and compounds across updates', () => {
    for (let i = 0; i < 5; i++) {
      updater.updateRubricsFromPatterns([
        { category: 'injection', avgScore: 1.0, caseCount: 10, trend: 'declining' },
      ], 5);
    }
    const weights = updater.getRubricWeights();
    expect(weights['injection']).toBe(2.0);
  });

  describe('rollbackIfNeeded', () => {
    it('returns false when no rubric exists for the category', () => {
      expect(updater.rollbackIfNeeded('unknown', 4.0, 3.0)).toBe(false);
    });

    it('returns false when rubric has no previous_weight', () => {
      updater.updateRubricsFromPatterns([
        { category: 'injection', avgScore: 1.5, caseCount: 6, trend: 'declining' },
      ], 5);
      expect(updater.rollbackIfNeeded('injection', 4.0, 3.0)).toBe(false);
    });

    it('restores previous weight and logs when score declines beyond threshold', () => {
      updater.updateRubricsFromPatterns([
        { category: 'injection', avgScore: 1.5, caseCount: 6, trend: 'declining' },
      ], 5);
      updater.updateRubricsFromPatterns([
        { category: 'injection', avgScore: 1.0, caseCount: 8, trend: 'declining' },
      ], 5);
      const weightsBefore = updater.getRubricWeights();
      expect(weightsBefore['injection']).toBe(1.44);

      const rolled = updater.rollbackIfNeeded('injection', 4.0, 3.5);
      expect(rolled).toBe(true);

      const weightsAfter = updater.getRubricWeights();
      expect(weightsAfter['injection']).toBe(1.2);

      const logs = db.prepare(
        'SELECT * FROM segml_judge_rollback_log WHERE category = ?',
      ).all('injection') as Array<{ from_weight: number; to_weight: number; reason: string }>;
      expect(logs.length).toBe(1);
      expect(logs[0].from_weight).toBe(1.44);
      expect(logs[0].to_weight).toBe(1.2);
      expect(logs[0].reason).toContain('4.00');
      expect(logs[0].reason).toContain('3.50');
    });

    it('returns false when score decline is exactly at threshold (0.2)', () => {
      updater.updateRubricsFromPatterns([
        { category: 'injection', avgScore: 1.5, caseCount: 6, trend: 'declining' },
      ], 5);
      updater.updateRubricsFromPatterns([
        { category: 'injection', avgScore: 1.0, caseCount: 8, trend: 'declining' },
      ], 5);
      expect(updater.rollbackIfNeeded('injection', 4.0, 3.8)).toBe(false);
    });

    it('returns false when score does not decline', () => {
      updater.updateRubricsFromPatterns([
        { category: 'injection', avgScore: 1.5, caseCount: 6, trend: 'declining' },
      ], 5);
      updater.updateRubricsFromPatterns([
        { category: 'injection', avgScore: 1.0, caseCount: 8, trend: 'declining' },
      ], 5);
      expect(updater.rollbackIfNeeded('injection', 3.0, 3.5)).toBe(false);
    });
  });
});
