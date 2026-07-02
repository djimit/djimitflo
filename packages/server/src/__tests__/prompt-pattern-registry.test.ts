import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { PromptPatternRegistry } from '../services/prompt-pattern-registry';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let registry: PromptPatternRegistry;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  registry = new PromptPatternRegistry(db);
});

afterEach(() => { db?.close(); });

describe('G124: PromptPatternRegistry', () => {
  it('registers pattern', () => {
    const pattern = registry.register('Fix TS', 'Fix TypeScript errors in {file}', 'typescript');
    expect(pattern.id).toBeDefined();
    expect(pattern.domain).toBe('typescript');
  });

  it('records success', () => {
    const pattern = registry.register('Test', 'Template', 'general');
    registry.recordSuccess(pattern.id);
    const patterns = registry.getAllPatterns(10);
    expect(patterns[0].successCount).toBe(1);
  });

  it('records failure', () => {
    const pattern = registry.register('Test', 'Template', 'general');
    registry.recordFailure(pattern.id);
    const patterns = registry.getAllPatterns(10);
    expect(patterns[0].failCount).toBe(1);
  });

  it('gets patterns for domain', () => {
    registry.register('P1', 'T1', 'math');
    registry.register('P2', 'T2', 'physics');
    const mathPatterns = registry.getPatternsForDomain('math');
    expect(mathPatterns.length).toBe(1);
  });

  it('gets best pattern', () => {
    const p1 = registry.register('P1', 'T1', 'general');
    registry.recordSuccess(p1.id);
    registry.recordSuccess(p1.id);
    const best = registry.getBestPattern('general');
    expect(best).not.toBeNull();
  });

  it('evaluates pattern', () => {
    const pattern = registry.register('Test', 'Template', 'general');
    const evalResult = registry.evaluate(pattern.id, 0.5, 0.8);
    expect(evalResult.improvement).toBe(0.3);
  });
});
