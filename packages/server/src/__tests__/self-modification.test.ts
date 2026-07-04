import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SelfModificationPipeline } from '../services/self-modification-pipeline';

describe('SelfModificationPipeline', () => {
  let db: Database.Database;
  let pipeline: SelfModificationPipeline;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    pipeline = new SelfModificationPipeline(db);
  });

  it('analyzes codebase for improvement opportunities', () => {
    const opportunities = pipeline.analyze();
    expect(Array.isArray(opportunities)).toBe(true);
  });

  it('creates a modification plan for an opportunity', () => {
    const opportunities = pipeline.analyze();
    if (opportunities.length > 0) {
      const plan = pipeline.createPlan(opportunities[0].id);
      expect(plan).toBeDefined();
      if (plan) {
        expect(plan.opportunityId).toBe(opportunities[0].id);
        expect(plan.changes.length).toBeGreaterThan(0);
      }
    }
  });

  it('returns null for non-existent opportunity', () => {
    const plan = pipeline.createPlan('nonexistent-id');
    expect(plan).toBeNull();
  });

  it('provides status summary', () => {
    const status = pipeline.getStatus();
    expect(status.opportunities).toBeDefined();
    expect(status.plans).toBeDefined();
    expect(status.implemented).toBeDefined();
    expect(status.rejected).toBeDefined();
  });

  it('stores opportunities in database', () => {
    pipeline.analyze();

    const rows = db.prepare('SELECT * FROM self_modification_opportunities').all();
    expect(Array.isArray(rows)).toBe(true);
  });

  it('stores plans in database', () => {
    const opportunities = pipeline.analyze();
    if (opportunities.length > 0) {
      pipeline.createPlan(opportunities[0].id);

      const rows = db.prepare('SELECT * FROM self_modification_plans').all();
      expect(rows.length).toBeGreaterThan(0);
    }
  });
});
