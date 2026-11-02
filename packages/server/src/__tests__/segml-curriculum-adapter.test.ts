import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { SegmlCurriculumAdapter } from '../services/segml-curriculum-adapter';

function seedPhase(
  db: Database,
  phase: number,
  name: string,
  categories: string[],
  minScore = 3.0,
): void {
  db.prepare(`
    INSERT INTO segml_curriculum_state (id, phase, name, categories_json, min_score)
    VALUES (?, ?, ?, ?, ?)
  `).run(randomUUID(), phase, name, JSON.stringify(categories), minScore);
}

describe('SegmlCurriculumAdapter', () => {
  let db: Database;
  let adapter: SegmlCurriculumAdapter;

  beforeEach(() => {
    db = new Database(':memory:');
    adapter = new SegmlCurriculumAdapter(db);
  });

  it('starts with 4 default phases with full content', () => {
    const phases = adapter.getPhases();
    expect(phases.length).toBe(4);
    expect(phases).toEqual([
      { phase: 1, name: 'Basic', categories: ['overthinking', 'contradiction', 'canary'], minScore: 3.0 },
      { phase: 2, name: 'Intermediate', categories: ['hierarchy', 'tool-scope', 'temporal-reasoning'], minScore: 3.5 },
      { phase: 3, name: 'Advanced', categories: ['injection', 'hallucination', 'calibration'], minScore: 3.5 },
      { phase: 4, name: 'Expert', categories: ['cross-lingual', 'temporal-reasoning'], minScore: 3.5 },
    ]);
  });

  it('adds critical blind spots to phase 1', () => {
    const result = adapter.adaptFromBlindSpots([
      { category: 'new_attack', avg_score: 1.0, case_count: 5, severity: 'critical', recommendation: 'test' },
    ], {});
    expect(result.phases_adjusted).toBe(1);
    expect(result.new_phases[0].categories).toContain('new_attack');
  });

  it('records previous/new categories and a reason when adding a critical blind spot', () => {
    const result = adapter.adaptFromBlindSpots([
      { category: 'new_attack', avg_score: 1.234, case_count: 5, severity: 'critical', recommendation: 'x' },
    ], {});
    expect(result.adjustments).toHaveLength(1);
    const adj = result.adjustments[0];
    expect(adj.phase).toBe(1);
    expect(adj.previous_categories).toEqual(['overthinking', 'contradiction', 'canary']);
    expect(adj.new_categories).toEqual(['overthinking', 'contradiction', 'canary', 'new_attack']);
    expect(adj.reason).toContain('new_attack');
    expect(adj.reason).toContain('critical');
    expect(adj.reason).toContain('1.23');
    // critical must target phase 1, not phase 2
    const phase2 = result.new_phases.find(p => p.phase === 2);
    expect(phase2?.categories).not.toContain('new_attack');
  });

  it('adds high-severity blind spots to phase 2 only', () => {
    const result = adapter.adaptFromBlindSpots([
      { category: 'emerging_threat', avg_score: 1.8, case_count: 4, severity: 'high', recommendation: 'test' },
    ], {});
    expect(result.phases_adjusted).toBeGreaterThanOrEqual(1);
    const phase2 = result.new_phases.find(p => p.phase === 2);
    expect(phase2?.categories).toContain('emerging_threat');
    // high severity must not touch phase 1
    expect(result.new_phases[0].categories).not.toContain('emerging_threat');
  });

  it('ignores low and medium severity blind spots and returns empty adjustments', () => {
    const result = adapter.adaptFromBlindSpots([
      { category: 'low_attack', avg_score: 2.0, case_count: 3, severity: 'low', recommendation: 'x' },
      { category: 'med_attack', avg_score: 2.0, case_count: 3, severity: 'medium', recommendation: 'x' },
    ], {});
    expect(result.phases_adjusted).toBe(0);
    expect(result.adjustments).toHaveLength(0);
    expect(result.new_phases).toHaveLength(4);
    expect(result.new_phases[0].categories).not.toContain('low_attack');
    expect(result.new_phases[1].categories).not.toContain('med_attack');
  });

  it('does not re-add a category already present in the target phase', () => {
    const result = adapter.adaptFromBlindSpots([
      { category: 'overthinking', avg_score: 1.0, case_count: 5, severity: 'critical', recommendation: 'x' },
    ], {});
    expect(result.phases_adjusted).toBe(0);
    expect(result.adjustments).toHaveLength(0);
    const phase1 = result.new_phases.find(p => p.phase === 1);
    expect(phase1?.categories.filter(c => c === 'overthinking')).toHaveLength(1);
  });

  it('does not remove categories if fewer than 3 would remain', () => {
    const result = adapter.adaptFromBlindSpots([], {
      overthinking: 4.8,
      contradiction: 4.9,
      canary: 3.0,
    });
    expect(result.phases_adjusted).toBe(0);
    expect(result.adjustments).toHaveLength(0);
  });

  it('does not remove categories if phase would have fewer than 3', () => {
    const result = adapter.adaptFromBlindSpots([], {
      overthinking: 4.9,
      contradiction: 4.9,
      canary: 4.9,
    });
    expect(result.phases_adjusted).toBe(0);
  });

  it('removes mastered categories from phase 2 when exactly 3 remain', () => {
    // grow phase 2 with a high-severity blind spot so it has 4 categories
    adapter.adaptFromBlindSpots([
      { category: 'emerging_threat', avg_score: 1.8, case_count: 4, severity: 'high', recommendation: 'x' },
    ], {});
    const result = adapter.adaptFromBlindSpots([], { hierarchy: 4.6 });
    expect(result.phases_adjusted).toBe(1);
    expect(result.adjustments).toHaveLength(1);
    const phase2 = result.new_phases.find(p => p.phase === 2);
    expect(phase2?.categories).toEqual(['tool-scope', 'temporal-reasoning', 'emerging_threat']);
    const adj = result.adjustments[0];
    expect(adj.phase).toBe(2);
    expect(adj.new_categories).toEqual(['tool-scope', 'temporal-reasoning', 'emerging_threat']);
    expect(adj.previous_categories).toHaveLength(4);
    expect(adj.previous_categories).toContain('hierarchy');
    expect(adj.reason).toContain('hierarchy');
    expect(adj.reason).toContain('phase 2');
  });

  it('does not remove mastered categories from phases 3 and 4', () => {
    const localDb = new Database(':memory:');
    const a = new SegmlCurriculumAdapter(localDb);
    seedPhase(localDb, 3, 'Advanced', ['injection', 'hallucination', 'calibration', 'extra1', 'extra2'], 3.5);
    const result = a.adaptFromBlindSpots([], { injection: 4.6, hallucination: 4.7 });
    expect(result.phases_adjusted).toBe(0);
    expect(result.adjustments).toHaveLength(0);
    const phase3 = result.new_phases.find(p => p.phase === 3);
    expect(phase3?.categories).toContain('injection');
    expect(phase3?.categories).toContain('hallucination');
  });

  it('treats score 4.5 as mastered and 4.49 as not mastered', () => {
    const localDb1 = new Database(':memory:');
    const a1 = new SegmlCurriculumAdapter(localDb1);
    seedPhase(localDb1, 1, 'Basic', ['overthinking', 'contradiction', 'canary', 'extra1'], 3.0);
    const r1 = a1.adaptFromBlindSpots([], { overthinking: 4.5 });
    expect(r1.phases_adjusted).toBe(1);
    expect(r1.new_phases[0].categories).not.toContain('overthinking');

    const localDb2 = new Database(':memory:');
    const a2 = new SegmlCurriculumAdapter(localDb2);
    seedPhase(localDb2, 1, 'Basic', ['overthinking', 'contradiction', 'canary', 'extra1'], 3.0);
    const r2 = a2.adaptFromBlindSpots([], { overthinking: 4.49 });
    expect(r2.phases_adjusted).toBe(0);
    expect(r2.new_phases[0].categories).toContain('overthinking');
  });

  it('persists adjustments across instances', () => {
    adapter.adaptFromBlindSpots([
      { category: 'zero_day', avg_score: 1.2, case_count: 6, severity: 'critical', recommendation: 'test' },
    ], {});
    const adapter2 = new SegmlCurriculumAdapter(db);
    const phases = adapter2.getPhases();
    expect(phases[0].categories).toContain('zero_day');
  });

  it('persists removal adjustments across instances', () => {
    // grow phase 1 then master one category so it is removed
    adapter.adaptFromBlindSpots([
      { category: 'extra1', avg_score: 1.0, case_count: 3, severity: 'critical', recommendation: 'x' },
    ], {});
    adapter.adaptFromBlindSpots([], { overthinking: 4.8 });
    const adapter2 = new SegmlCurriculumAdapter(db);
    const phase1 = adapter2.getPhases().find(p => p.phase === 1);
    expect(phase1?.categories).not.toContain('overthinking');
    expect(phase1?.categories).toContain('extra1');
  });
});