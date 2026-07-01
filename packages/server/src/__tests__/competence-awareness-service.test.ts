import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CompetenceAwarenessService } from '../services/competence-awareness-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let competence: CompetenceAwarenessService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  competence = new CompetenceAwarenessService(db);
});

afterEach(() => {
  db?.close();
});

describe('G56: Competence Awareness', () => {
  it('assessNovelty returns assessment', () => {
    const result = competence.assessNovelty({ type: 'unknown_type', description: 'completely new situation' });
    expect(result).toBeDefined();
    expect(typeof result.isNovel).toBe('boolean');
    expect(result.distance).toBeGreaterThanOrEqual(0);
  });

  it('estimateCompetence returns 0.5 for unknown', () => {
    const comp = competence.estimateCompetence('nonexistent');
    expect(comp).toBe(0.5);
  });

  it('determineMode returns normal for high competence', () => {
    expect(competence.determineMode(0.8)).toBe('normal');
  });

  it('determineMode returns cautious for medium', () => {
    expect(competence.determineMode(0.5)).toBe('cautious');
  });

  it('determineMode returns conservative for low + novel', () => {
    expect(competence.determineMode(0.2, true)).toBe('conservative');
  });

  it('getOperationMode returns mode for finding', () => {
    const mode = competence.getOperationMode({ type: 'doc-drift', description: 'fix documentation' });
    expect(['normal', 'cautious', 'conservative']).toContain(mode);
  });

  it('novel finding triggers conservative mode', () => {
    const result = competence.assessNovelty({ type: 'xyzabc123', description: 'completely unrelated domain' });
    expect(result.isNovel).toBe(true);
  });
});
