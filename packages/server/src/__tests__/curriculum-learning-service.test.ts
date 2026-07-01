import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CurriculumLearningService } from '../services/curriculum-learning-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let curriculum: CurriculumLearningService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  curriculum = new CurriculumLearningService(db);
});

afterEach(() => {
  db?.close();
});

describe('G62: Curriculum Learning', () => {
  it('generates curriculum for typescript goal', () => {
    const steps = curriculum.generateCurriculum('Fix TypeScript errors');
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0].status).toBe('available');
  });

  it('generates curriculum for security goal', () => {
    const steps = curriculum.generateCurriculum('Fix security issues');
    expect(steps.length).toBeGreaterThan(0);
  });

  it('steps have increasing difficulty', () => {
    const steps = curriculum.generateCurriculum('Fix TypeScript errors');
    if (steps.length >= 2) {
      expect(steps[steps.length - 1].difficulty).toBeGreaterThan(steps[0].difficulty);
    }
  });

  it('getAvailableSteps returns only available', () => {
    const steps = curriculum.generateCurriculum('test goal');
    const curriculumId = (db.prepare("SELECT curriculum_id FROM curriculum_steps LIMIT 1").get() as { curriculum_id: string }).curriculum_id;
    const available = curriculum.getAvailableSteps(curriculumId);
    for (const step of available) {
      expect(step.status).toBe('available');
    }
  });

  it('advanceStep unlocks next step', () => {
    curriculum.generateCurriculum('test goal');
    const curriculumId = (db.prepare("SELECT curriculum_id FROM curriculum_steps LIMIT 1").get() as { curriculum_id: string }).curriculum_id;
    const available = curriculum.getAvailableSteps(curriculumId);
    if (available.length > 0) {
      curriculum.startStep(available[0].id);
      curriculum.advanceStep(available[0].id);
      const completed = db.prepare("SELECT status FROM curriculum_steps WHERE id = ?").get(available[0].id) as { status: string };
      expect(completed.status).toBe('completed');
    }
  });

  it('evaluateMastery returns 0 for unknown', () => {
    expect(curriculum.evaluateMastery('nonexistent')).toBe(0);
  });

  it('startStep changes status', () => {
    curriculum.generateCurriculum('test goal');
    const curriculumId = (db.prepare("SELECT curriculum_id FROM curriculum_steps LIMIT 1").get() as { curriculum_id: string }).curriculum_id;
    const available = curriculum.getAvailableSteps(curriculumId);
    if (available.length > 0) {
      curriculum.startStep(available[0].id);
      const started = db.prepare("SELECT status FROM curriculum_steps WHERE id = ?").get(available[0].id) as { status: string };
      expect(started.status).toBe('in_progress');
    }
  });

  it('getLearningPath returns full curriculum', () => {
    const steps = curriculum.generateCurriculum('test goal');
    const curriculumId = (db.prepare("SELECT curriculum_id FROM curriculum_steps LIMIT 1").get() as { curriculum_id: string }).curriculum_id;
    const path = curriculum.getLearningPath(curriculumId);
    expect(path.length).toBe(steps.length);
  });

  it('steps have prerequisites', () => {
    const steps = curriculum.generateCurriculum('Fix TypeScript errors');
    if (steps.length >= 2) {
      expect(steps[1].prerequisites.length).toBeGreaterThan(0);
    }
  });
});
