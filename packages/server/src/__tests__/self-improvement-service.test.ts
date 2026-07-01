import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SelfImprovementService } from '../services/self-improvement-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let improvement: SelfImprovementService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  improvement = new SelfImprovementService(db);
});

afterEach(() => {
  db?.close();
});

describe('G71: Self Improvement', () => {
  it('generates from reflection', () => {
    const proposals = improvement.generateFromReflection({
      whatFailed: ['test failed'],
      lessonsLearned: ['Need better error handling'],
      proposedImprovements: ['Add try-catch to all handlers'],
    });
    expect(proposals.length).toBe(1);
    expect(proposals[0].type).toBe('bug_fix');
  });

  it('generates from knowledge gaps', () => {
    const proposals = improvement.generateFromGaps([
      { domain: 'kubernetes', description: 'Need to learn K8s' },
    ]);
    expect(proposals.length).toBe(1);
    expect(proposals[0].type).toBe('feature');
  });

  it('generates from build errors', () => {
    const proposals = improvement.generateFromBuildErrors(['ERROR: type mismatch']);
    expect(proposals.length).toBe(1);
    expect(proposals[0].priority).toBeGreaterThan(0.9);
  });

  it('gets proposed improvements', () => {
    improvement.generateFromReflection({
      whatFailed: [],
      lessonsLearned: [],
      proposedImprovements: ['Improve X'],
    });
    const proposed = improvement.getProposedImprovements();
    expect(proposed.length).toBe(1);
  });

  it('approves improvement', () => {
    const proposals = improvement.generateFromReflection({
      whatFailed: [],
      lessonsLearned: [],
      proposedImprovements: ['Fix Y'],
    });
    improvement.approveImprovement(proposals[0].id);
    const proposed = improvement.getProposedImprovements();
    expect(proposed.length).toBe(0);
  });

  it('completes improvement', () => {
    const proposals = improvement.generateFromReflection({
      whatFailed: [],
      lessonsLearned: [],
      proposedImprovements: ['Add Z'],
    });
    improvement.completeImprovement(proposals[0].id);
    const history = improvement.getImprovementHistory(10);
    expect(history[0].status).toBe('completed');
  });

  it('classifies security improvements', () => {
    const proposals = improvement.generateFromReflection({
      whatFailed: [],
      lessonsLearned: [],
      proposedImprovements: ['Fix security vulnerability in auth'],
    });
    expect(proposals[0].type).toBe('security');
  });

  it('gets improvement history', () => {
    improvement.generateFromReflection({
      whatFailed: [],
      lessonsLearned: [],
      proposedImprovements: ['A', 'B'],
    });
    const history = improvement.getImprovementHistory(10);
    expect(history.length).toBe(2);
  });
});
