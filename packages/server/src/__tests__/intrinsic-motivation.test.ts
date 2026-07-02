import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { IntrinsicMotivationModule } from '../services/intrinsic-motivation-service';
import { CuriosityService } from '../services/curiosity-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let motivation: IntrinsicMotivationModule;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  const intelligence = new SwarmIntelligenceService(db);
  const curiosity = new CuriosityService(db, intelligence);
  motivation = new IntrinsicMotivationModule(db, curiosity);
});

afterEach(() => {
  db?.close();
});

describe('G113: IntrinsicMotivationModule', () => {
  it('scores curiosity for unknown domain', () => {
    const score = motivation.scoreCuriosity('unknown-domain');
    expect(score).toBeGreaterThan(0.5);
  });

  it('scores lower curiosity for known domain', () => {
    db.prepare("INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, status, confidence, evidence_refs_json, created_from, created_at, updated_at) VALUES ('c1', 'test', 'memory', 'known-domain', 'supported', 0.8, '[]', 'test', datetime('now'), datetime('now'))").run();
    db.prepare("INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, status, confidence, evidence_refs_json, created_from, created_at, updated_at) VALUES ('c2', 'test', 'memory', 'known-domain', 'supported', 0.8, '[]', 'test', datetime('now'), datetime('now'))").run();
    db.prepare("INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, status, confidence, evidence_refs_json, created_from, created_at, updated_at) VALUES ('c3', 'test', 'memory', 'known-domain', 'supported', 0.8, '[]', 'test', datetime('now'), datetime('now'))").run();

    const score = motivation.scoreCuriosity('known-domain');
    expect(score).toBeLessThan(0.5);
  });

  it('explores new domain', () => {
    const result = motivation.exploreNewDomain('quantum-computing');
    expect(result.started).toBe(true);
    expect(result.goalId).toBeDefined();
  });

  it('does not duplicate active exploration', () => {
    motivation.exploreNewDomain('blockchain');
    const result = motivation.exploreNewDomain('blockchain');
    expect(result.started).toBe(false);
  });

  it('gets exploration stats', () => {
    motivation.exploreNewDomain('ai-safety');
    const stats = motivation.getExplorationStats();
    expect(stats.totalExplorations).toBe(1);
    expect(stats.activeExplorations).toBe(1);
  });

  it('completes exploration', () => {
    const result = motivation.exploreNewDomain('rust-programming');
    if (result.goalId) {
      motivation.completeExploration(result.goalId);
      const stats = motivation.getExplorationStats();
      expect(stats.completedExplorations).toBe(1);
    }
  });

  it('gets proposed goals', () => {
    const goals = motivation.getProposedGoals(10);
    expect(Array.isArray(goals)).toBe(true);
  });
});
