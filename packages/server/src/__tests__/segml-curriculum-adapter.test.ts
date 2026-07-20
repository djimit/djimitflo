import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SegmlCurriculumAdapter } from '../services/segml-curriculum-adapter';

describe('SegmlCurriculumAdapter', () => {
  let db: Database;
  let adapter: SegmlCurriculumAdapter;

  beforeEach(() => {
    db = new Database(':memory:');
    adapter = new SegmlCurriculumAdapter(db);
  });

  it('starts with 4 default phases', () => {
    const phases = adapter.getPhases();
    expect(phases.length).toBe(4);
    expect(phases[0].name).toBe('Basic');
    expect(phases[3].name).toBe('Expert');
  });

  it('adds critical blind spots to phase 1', () => {
    const result = adapter.adaptFromBlindSpots([
      { category: 'new_attack', avg_score: 1.0, case_count: 5, severity: 'critical', recommendation: 'test' },
    ], {});
    expect(result.phases_adjusted).toBe(1);
    expect(result.new_phases[0].categories).toContain('new_attack');
  });

  it('adds high-severity blind spots to phase 2', () => {
    const result = adapter.adaptFromBlindSpots([
      { category: 'emerging_threat', avg_score: 1.8, case_count: 4, severity: 'high', recommendation: 'test' },
    ], {});
    expect(result.phases_adjusted).toBeGreaterThanOrEqual(1);
    const phase2 = result.new_phases.find(p => p.phase === 2);
    expect(phase2?.categories).toContain('emerging_threat');
  });

  it('does not remove categories if fewer than 3 would remain', () => {
    const result = adapter.adaptFromBlindSpots([], {
      overthinking: 4.8,
      contradiction: 4.9,
      canary: 3.0,
    });
    expect(result.phases_adjusted).toBe(0);
  });

  it('does not remove categories if phase would have fewer than 3', () => {
    const result = adapter.adaptFromBlindSpots([], {
      overthinking: 4.9,
      contradiction: 4.9,
      canary: 4.9,
    });
    expect(result.phases_adjusted).toBe(0);
  });

  it('persists adjustments across instances', () => {
    adapter.adaptFromBlindSpots([
      { category: 'zero_day', avg_score: 1.2, case_count: 6, severity: 'critical', recommendation: 'test' },
    ], {});
    const adapter2 = new SegmlCurriculumAdapter(db);
    const phases = adapter2.getPhases();
    expect(phases[0].categories).toContain('zero_day');
  });
});
