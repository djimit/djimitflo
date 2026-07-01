import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { EpistemicGateService } from '../services/epistemic-gate-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let gates: EpistemicGateService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  gates = new EpistemicGateService(db);
});

afterEach(() => {
  db?.close();
});

describe('G38: Epistemic Gates', () => {
  it('source_quality: fails with 0 sources', () => {
    const result = gates.evaluateSourceQuality([]);
    expect(result.status).toBe('fail');
    expect(result.name).toBe('source_quality');
  });

  it('source_quality: fails with 1 source', () => {
    const result = gates.evaluateSourceQuality(['source:abc']);
    expect(result.status).toBe('fail');
  });

  it('source_quality: passes with 2 sources', () => {
    const result = gates.evaluateSourceQuality(['source:abc', 'citation:def']);
    expect(result.status).toBe('pass');
  });

  it('logical_consistency: passes with no contradictions', () => {
    const result = gates.evaluateLogicalConsistency(['claim:nonexistent']);
    expect(result.status).toBe('pass');
  });

  it('logical_consistency: fails with contradicts edge', () => {
    db.prepare(`INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, status, created_from, created_at, updated_at) VALUES ('c1', 'test', 'memory', 'test', 'supported', 'test', datetime('now'), datetime('now'))`).run();
    db.prepare(`INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, status, contradicts_ref, created_from, created_at, updated_at) VALUES ('c2', 'opposite', 'memory', 'test', 'contradicted', 'c1', 'test', datetime('now'), datetime('now'))`).run();
    db.prepare(`INSERT INTO swarm_evidence_edges (id, from_ref, to_ref, relation, created_at) VALUES ('e1', 'c2', 'c1', 'contradicts', datetime('now'))`).run();
    const result = gates.evaluateLogicalConsistency(['claim:c2']);
    expect(result.status).toBe('fail');
  });

  it('perspective_coverage: skipped with no panels', () => {
    const result = gates.evaluatePerspectiveCoverage([]);
    expect(result.status).toBe('skipped');
  });

  it('perspective_coverage: fails with 1 domain', () => {
    db.prepare(`INSERT INTO specialist_panels (id, topic, question, status, risk_class, metadata, created_at, updated_at) VALUES ('p1', 'test', 'test', 'consensus_ready', 'low', '{"participants":[{"domain":"security"}]}', datetime('now'), datetime('now'))`).run();
    const result = gates.evaluatePerspectiveCoverage(['p1']);
    expect(result.status).toBe('fail');
  });

  it('perspective_coverage: passes with 2 domains', () => {
    db.prepare(`INSERT INTO specialist_panels (id, topic, question, status, risk_class, metadata, created_at, updated_at) VALUES ('p2', 'test', 'test', 'consensus_ready', 'low', '{"participants":[{"domain":"security"},{"domain":"performance"}]}', datetime('now'), datetime('now'))`).run();
    const result = gates.evaluatePerspectiveCoverage(['p2']);
    expect(result.status).toBe('pass');
  });

  it('perspective_coverage: passes with dissent', () => {
    db.prepare(`INSERT INTO specialist_panels (id, topic, question, status, risk_class, metadata, created_at, updated_at) VALUES ('p3', 'test', 'test', 'consensus_ready', 'low', '{"participants":[{"domain":"security"}],"consensus":{"oppose_count":1}}', datetime('now'), datetime('now'))`).run();
    const result = gates.evaluatePerspectiveCoverage(['p3']);
    expect(result.status).toBe('pass');
  });

  it('falsifiability: fails with vague text', () => {
    const result = gates.evaluateFalsifiability('We made things better and improved quality.', []);
    expect(result.status).toBe('fail');
  });

  it('falsifiability: passes with testable claim', () => {
    const result = gates.evaluateFalsifiability('This change causes a 30% reduction in response time.', []);
    expect(result.status).toBe('pass');
  });

  it('falsifiability: passes with hypothesis link', () => {
    db.prepare(`INSERT INTO swarm_hypotheses (id, question, projection_state, created_at, updated_at) VALUES ('h1', 'test', 'testing', datetime('now'), datetime('now'))`).run();
    const result = gates.evaluateFalsifiability('vague text', ['h1']);
    expect(result.status).toBe('pass');
  });

  it('falsifiability: fails with draft hypothesis', () => {
    db.prepare(`INSERT INTO swarm_hypotheses (id, question, projection_state, created_at, updated_at) VALUES ('h2', 'test', 'draft', datetime('now'), datetime('now'))`).run();
    const result = gates.evaluateFalsifiability('vague text', ['h2']);
    expect(result.status).toBe('fail');
  });

  it('runAllGates returns all 4 gates', () => {
    const results = gates.runAllGates({});
    expect(results.length).toBe(4);
    const names = results.map(r => r.name);
    expect(names).toContain('source_quality');
    expect(names).toContain('logical_consistency');
    expect(names).toContain('perspective_coverage');
    expect(names).toContain('falsifiability');
  });

  it('all gates have confidence between 0 and 1', () => {
    const results = gates.runAllGates({});
    for (const r of results) {
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });
});
