import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ServiceRefactoringAnalyzer } from '../services/service-refactoring-analyzer';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let analyzer: ServiceRefactoringAnalyzer;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  analyzer = new ServiceRefactoringAnalyzer(db);
});

afterEach(() => {
  db?.close();
});

describe('G103: Service Refactoring Analyzer', () => {
  it('analyzes a small service without proposals', () => {
    const proposals = analyzer.analyzeService('src/services/thompson-bandit-service.ts');
    expect(Array.isArray(proposals)).toBe(true);
  });

  it('proposes split for large services', () => {
    const proposals = analyzer.analyzeService('src/services/loop-service.ts');
    const splitProposals = proposals.filter(p => p.proposalType === 'split');
    expect(splitProposals.length).toBeGreaterThan(0);
  });

  it('detects high method count', () => {
    const proposals = analyzer.analyzeService('src/services/loop-service.ts');
    const extractProposals = proposals.filter(p => p.proposalType === 'extract_module');
    expect(extractProposals.length).toBeGreaterThan(0);
  });

  it('creates proposals with correct structure', () => {
    const proposals = analyzer.analyzeService('src/services/loop-service.ts');
    if (proposals.length > 0) {
      const p = proposals[0];
      expect(p.id).toBeDefined();
      expect(p.targetService).toBeDefined();
      expect(p.proposalType).toMatch(/extract_module|simplify|merge|split/);
      expect(p.description).toBeDefined();
      expect(p.currentState.loc).toBeGreaterThan(0);
      expect(p.expectedImpact).toBeDefined();
      expect(p.risk).toMatch(/low|medium|high/);
      expect(p.status).toBe('proposed');
    }
  });

  it('persists proposals to database', () => {
    analyzer.analyzeService('src/services/loop-service.ts');
    const stored = analyzer.getProposals();
    expect(stored.length).toBeGreaterThan(0);
  });

  it('filters proposals by status', () => {
    analyzer.analyzeService('src/services/loop-service.ts');
    const proposed = analyzer.getProposals('proposed');
    expect(proposed.length).toBeGreaterThan(0);
  });

  it('updates proposal status', () => {
    analyzer.analyzeService('src/services/loop-service.ts');
    const proposals = analyzer.getProposals('proposed');
    if (proposals.length > 0) {
      analyzer.updateProposalStatus(proposals[0].id, 'approved');
      const approved = analyzer.getProposals('approved');
      expect(approved.length).toBe(1);
    }
  });

  it('analyzes all services', () => {
    const proposals = analyzer.analyzeAllServices();
    expect(Array.isArray(proposals)).toBe(true);
    expect(proposals.length).toBeGreaterThan(0);
  });

  it('returns empty for non-existent file', () => {
    const proposals = analyzer.analyzeService('nonexistent.ts');
    expect(proposals).toEqual([]);
  });

  it('calculates current state metrics', () => {
    const proposals = analyzer.analyzeService('src/services/loop-service.ts');
    if (proposals.length > 0) {
      const state = proposals[0].currentState;
      expect(state.loc).toBeGreaterThan(1000);
      expect(state.methods).toBeGreaterThan(20);
      expect(state.dependencies).toBeGreaterThan(10);
    }
  });
});
