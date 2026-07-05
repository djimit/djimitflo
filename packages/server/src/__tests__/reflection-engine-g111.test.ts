import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ReflectionEngine } from '../services/reflection-engine';
import { createTestDb } from './helpers/test-db';


let db: Database.Database;
let engine: ReflectionEngine;

beforeEach(() => {
  db = createTestDb();
  db.pragma('foreign_keys = ON');
  
  
  engine = new ReflectionEngine(db);
});

afterEach(() => {
  db?.close();
});

describe('G111: ReflectionEngine Extension', () => {
  it('analyzes reflection patterns', () => {
    const report = engine.analyzeReflectionPatterns();
    expect(report.totalReflections).toBe(0);
    expect(Array.isArray(report.recurringPatterns)).toBe(true);
  });

  it('generates meta-learning proposals', () => {
    const proposals = engine.generateMetaLearningProposals();
    expect(Array.isArray(proposals)).toBe(true);
  });

  it('correlates with outcomes', () => {
    const report = engine.correlateWithOutcomes();
    expect(report.totalRuns).toBe(0);
    expect(typeof report.reflectionSuccessRate).toBe('number');
  });

  it('detects recurring patterns after multiple reflections', () => {
    for (let i = 0; i < 5; i++) {
      engine.reflectOnRun(`run-${i}`);
    }

    const report = engine.analyzeReflectionPatterns(10);
    expect(report.totalReflections).toBe(5);
    expect(Array.isArray(report.topLessons)).toBe(true);
  });
});
