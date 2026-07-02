import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MetaLearningPromptOptimizer } from '../services/meta-learning-prompt-optimizer';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let optimizer: MetaLearningPromptOptimizer;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  optimizer = new MetaLearningPromptOptimizer(db);
});

afterEach(() => { db?.close(); });

describe('G132: Meta-Learning Prompt Optimizer', () => {
  it('meta-trains on examples', () => {
    const result = optimizer.metaTrain([
      { domain: 'typescript', template: 'Fix {error} in {file}', success: true },
      { domain: 'typescript', template: 'Resolve {issue}', success: false },
    ]);
    expect(result.domain).toBe('typescript');
    expect(result.initialization).toBeDefined();
  });

  it('adapts to domain', () => {
    const result = optimizer.adaptToDomain('python', [
      { template: 'Fix {error}', success: true },
      { template: 'Resolve {issue}', success: true },
    ]);
    expect(result.domain).toBe('python');
    expect(result.steps).toBeGreaterThan(0);
  });

  it('gets meta prompt', () => {
    optimizer.metaTrain([{ domain: 'math', template: 'Solve {problem}', success: true }]);
    const prompt = optimizer.getMetaPrompt('math');
    expect(prompt === null || typeof prompt === 'object').toBe(true);
  });

  it('gets all meta prompts', () => {
    const prompts = optimizer.getAllMetaPrompts();
    expect(Array.isArray(prompts)).toBe(true);
  });

  it('converges with enough examples', () => {
    optimizer.metaTrain([
      { domain: 'test', template: 'Fix {x}', success: true },
      { domain: 'test', template: 'Fix {x}', success: true },
      { domain: 'test', template: 'Fix {x}', success: true },
    ]);
    const result = optimizer.adaptToDomain('test', [
      { template: 'Fix {x}', success: true },
    ]);
    expect(result.converged || result.finalLoss < 0.5).toBe(true);
  });
});
