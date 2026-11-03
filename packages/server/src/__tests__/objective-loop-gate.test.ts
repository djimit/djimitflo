import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { objectiveModeEnabled, objectiveModeMaxPerTick, goalQualifiesForObjectiveMode } from '../services/objective-loop-gate';

describe('objective-loop-gate', () => {
  const prevEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED', 'SELF_IMPROVEMENT_OBJECTIVE_LOOP_MAX_PER_TICK']) {
      prevEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('objectiveModeEnabled', () => {
    it('is false by default', () => {
      expect(objectiveModeEnabled()).toBe(false);
    });

    it('is true only when the flag is exactly "true"', () => {
      process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED = 'yes';
      expect(objectiveModeEnabled()).toBe(false);
      process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED = 'true';
      expect(objectiveModeEnabled()).toBe(true);
    });
  });

  describe('objectiveModeMaxPerTick', () => {
    it('defaults to 1', () => {
      expect(objectiveModeMaxPerTick()).toBe(1);
    });

    it('honors a valid override', () => {
      process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_MAX_PER_TICK = '2';
      expect(objectiveModeMaxPerTick()).toBe(2);
    });

    it('falls back to the default for invalid configuration', () => {
      process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_MAX_PER_TICK = 'not-a-number';
      expect(objectiveModeMaxPerTick()).toBe(1);
      process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_MAX_PER_TICK = '-5';
      expect(objectiveModeMaxPerTick()).toBe(1);
    });

    it('clamps to the hard ceiling of 3', () => {
      process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_MAX_PER_TICK = '999';
      expect(objectiveModeMaxPerTick()).toBe(3);
    });
  });

  describe('goalQualifiesForObjectiveMode', () => {
    it('disqualifies a goal that is not self-improvement-sourced', () => {
      const result = goalQualifiesForObjectiveMode({ risk_class: 'low', metadata: { source: 'security-scan' } });
      expect(result).toEqual({ qualifies: false, reason: 'not_self_improvement_source' });
    });

    it('disqualifies a goal with no source at all', () => {
      const result = goalQualifiesForObjectiveMode({ risk_class: 'low', metadata: {} });
      expect(result.qualifies).toBe(false);
      expect(result.reason).toBe('not_self_improvement_source');
    });

    it.each(['medium', 'high', 'critical'])('disqualifies a self-improvement goal with risk_class %s', (riskClass) => {
      const result = goalQualifiesForObjectiveMode({ risk_class: riskClass, metadata: { source: 'self-improvement' } });
      expect(result).toEqual({ qualifies: false, reason: `risk_class_not_low:${riskClass}` });
    });

    it('qualifies a low-risk self-improvement goal', () => {
      const result = goalQualifiesForObjectiveMode({ risk_class: 'low', metadata: { source: 'self-improvement' } });
      expect(result).toEqual({ qualifies: true, reason: 'qualifies' });
    });
  });
});
