import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SegmlSkillEvolutionBridge } from '../services/segml-skill-evolution-bridge';

describe('SegmlSkillEvolutionBridge', () => {
  let db: Database.Database;
  let bridge: SegmlSkillEvolutionBridge;

  beforeEach(() => {
    db = new Database(':memory:');
    bridge = new SegmlSkillEvolutionBridge(db);
  });

  it('calculates governance-weighted fitness', () => {
    const result = bridge.calculateGovernanceFitness({
      skillId: 'skill-1',
      baseTraits: { efficiency: 0.8, reliability: 0.7, generality: 0.5, complexity: 0.3, adaptability: 0.6 },
      governanceScore: 4.5,
      categoryScores: { injection: 4.0, calibration: 5.0 },
    });
    expect(result.baseFitness).toBeGreaterThan(0);
    expect(result.governanceWeightedFitness).toBeGreaterThan(0);
    expect(result.promotionApproved).toBe(true);
  });

  it('quarantines skills with low governance score', () => {
    const result = bridge.calculateGovernanceFitness({
      skillId: 'skill-dangerous',
      baseTraits: { efficiency: 0.9, reliability: 0.8, generality: 0.7, complexity: 0.2, adaptability: 0.8 },
      governanceScore: 1.5,
      categoryScores: { injection: 1.0 },
    });
    expect(result.quarantined).toBe(true);
    expect(result.governancePenalty).toBeGreaterThan(0);
    expect(result.governanceWeightedFitness).toBeLessThan(result.baseFitness);
  });

  it('applies governance bonus for excellent scores', () => {
    const result = bridge.calculateGovernanceFitness({
      skillId: 'skill-excellent',
      baseTraits: { efficiency: 0.7, reliability: 0.7, generality: 0.5, complexity: 0.5, adaptability: 0.5 },
      governanceScore: 4.5,
      categoryScores: {},
    });
    expect(result.governanceBonus).toBeGreaterThan(0);
    expect(result.promotionApproved).toBe(true);
  });

  it('records governance assessment', () => {
    bridge.recordAssessment({
      skillId: 'skill-1',
      overallScore: 1.5,
      categoryScores: { injection: 1.0 },
      fitnessBefore: 0.7,
      fitnessAfter: 0.35,
      quarantined: true,
      assessedAt: new Date().toISOString(),
    });
    const quarantined = bridge.getQuarantinedSkills();
    expect(quarantined.length).toBe(1);
  });

  it('gets skill governance history', () => {
    bridge.recordAssessment({
      skillId: 'skill-1',
      overallScore: 3.0,
      categoryScores: {},
      fitnessBefore: 0.6,
      fitnessAfter: 0.6,
      quarantined: false,
      assessedAt: new Date().toISOString(),
    });
    const history = bridge.getSkillHistory('skill-1');
    expect(history.length).toBe(1);
  });
});
