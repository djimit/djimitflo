import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { DomainAdaptiveCurriculumService } from '../services/domain-adaptive-curriculum-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let curriculum: DomainAdaptiveCurriculumService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  curriculum = new DomainAdaptiveCurriculumService(db);
});

afterEach(() => {
  db?.close();
});

describe('G78: Domain-Adaptive Curriculum', () => {
  it('detects infrastructure domain', () => {
    expect(curriculum.detectDomain('Deploy with Docker')).toBe('infrastructure');
  });

  it('detects data domain', () => {
    expect(curriculum.detectDomain('Build ETL pipeline')).toBe('data');
  });

  it('detects communication domain', () => {
    expect(curriculum.detectDomain('Send email notification')).toBe('communication');
  });

  it('detects research domain', () => {
    expect(curriculum.detectDomain('Write research paper')).toBe('research');
  });

  it('detects code domain', () => {
    expect(curriculum.detectDomain('Refactor TypeScript code')).toBe('code');
  });

  it('generates curriculum for infrastructure', () => {
    const result = curriculum.generateCurriculum('infrastructure');
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.steps[0].status).toBe('available');
  });

  it('generates curriculum for data', () => {
    const result = curriculum.generateCurriculum('data');
    expect(result.steps.length).toBeGreaterThan(0);
  });

  it('gets domain steps', () => {
    curriculum.generateCurriculum('code');
    const steps = curriculum.getDomainSteps('code');
    expect(steps.length).toBeGreaterThan(0);
  });

  it('generates for unknown domain', () => {
    const result = curriculum.generateCurriculum('quantum-computing');
    expect(result.steps.length).toBeGreaterThan(0);
  });
});
