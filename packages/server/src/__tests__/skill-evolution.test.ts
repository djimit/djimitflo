import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SkillDistillationService } from '../services/skill-distillation-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let service: SkillDistillationService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  service = new SkillDistillationService(db);
});

afterEach(() => {
  db?.close();
});

describe('G101: Skill Evolution', () => {
  it('generates improvement for low confidence results', () => {
    const results = [
      { domain: 'physics', content: 'Test', source: 'wikipedia', confidence: 0.3 },
    ];

    const improvements = service.analyzeSkillPerformance('skill-1', results);
    expect(improvements.length).toBeGreaterThan(0);
    expect(improvements[0].type).toBe('clarity');
  });

  it('does not generate improvement for high confidence', () => {
    const results = [
      { domain: 'physics', content: 'Test', source: 'arxiv', confidence: 0.9 },
    ];

    const improvements = service.analyzeSkillPerformance('skill-1', results);
    expect(improvements.length).toBe(0);
  });

  it('flags single-domain coverage', () => {
    const results = [
      { domain: 'physics', content: 'Test 1', source: 'wikipedia', confidence: 0.8 },
      { domain: 'physics', content: 'Test 2', source: 'arxiv', confidence: 0.9 },
    ];

    const improvements = service.analyzeSkillPerformance('skill-1', results);
    expect(improvements.some(i => i.type === 'coverage')).toBe(true);
  });

  it('does not flag multi-domain coverage', () => {
    const results = [
      { domain: 'physics', content: 'Test 1', source: 'wikipedia', confidence: 0.8 },
      { domain: 'math', content: 'Test 2', source: 'arxiv', confidence: 0.9 },
    ];

    const improvements = service.analyzeSkillPerformance('skill-1', results);
    expect(improvements.some(i => i.type === 'coverage')).toBe(false);
  });

  it('returns empty for empty results', () => {
    const improvements = service.analyzeSkillPerformance('skill-1', []);
    expect(improvements).toEqual([]);
  });

  it('includes skill_id in improvements', () => {
    const results = [
      { domain: 'physics', content: 'Test', source: 'wikipedia', confidence: 0.2 },
    ];

    const improvements = service.analyzeSkillPerformance('my-skill', results);
    expect(improvements[0].skill_id).toBe('my-skill');
  });
});
