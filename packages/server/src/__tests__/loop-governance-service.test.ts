import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { LoopGovernanceService } from '../services/loop-governance-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let governance: LoopGovernanceService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  governance = new LoopGovernanceService(db);
});

afterEach(() => {
  db?.close();
});

describe('G110: LoopGovernanceService', () => {
  it('checks gates for nonexistent run', () => {
    const result = governance.checkGates('nonexistent');
    expect(result.passed).toBe(false);
  });

  it('evaluates token budget within limits', () => {
    const decision = governance.evaluateTokenBudget('run-1', 500, 1000);
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(500);
  });

  it('blocks token budget over limits', () => {
    const decision = governance.evaluateTokenBudget('run-1', 1500, 1000);
    expect(decision.allowed).toBe(false);
  });

  it('evaluates dollar budget within limits', () => {
    const decision = governance.evaluateDollarBudget('run-1', 5, 10);
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(5);
  });

  it('blocks dollar budget over limits', () => {
    const decision = governance.evaluateDollarBudget('run-1', 15, 10);
    expect(decision.allowed).toBe(false);
  });

  it('computes learning curve', () => {
    const curve = governance.computeLearningCurve(10);
    expect(Array.isArray(curve)).toBe(true);
  });

  it('gets success rate', () => {
    const rate = governance.getSuccessRate(20);
    expect(rate).toBeGreaterThanOrEqual(0);
    expect(rate).toBeLessThanOrEqual(1);
  });

  it('escalates on threshold', () => {
    expect(governance.shouldEscalate('run-1', 3, 3)).toBe(true);
    expect(governance.shouldEscalate('run-1', 2, 3)).toBe(false);
  });

  it('gets budget status', () => {
    const status = governance.getBudgetStatus('run-1');
    expect(status.leasesActive).toBe(0);
    expect(status.leasesCompleted).toBe(0);
  });
});
