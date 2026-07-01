import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MetaEvolutionService } from '../services/meta-evolution-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let intelligence: SwarmIntelligenceService;
let metaEvolution: MetaEvolutionService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  intelligence = new SwarmIntelligenceService(db);
  metaEvolution = new MetaEvolutionService(db, intelligence, { intervalMs: 999999999 });
});

afterEach(() => {
  db?.close();
});

describe('G44: Adaptive Self-Modification', () => {
  it('synthesizes draft contracts from recurring gaps', () => {
    for (let i = 0; i < 4; i++) {
      db.prepare(
        "INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, predicate, status, confidence, evidence_refs_json, created_from, created_at, updated_at) VALUES (?, 'gap', 'capability', 'security', 'gap', 'proposed', 0.5, '[]', 'test', datetime('now'), datetime('now'))"
      ).run('gap-synth-' + i);
    }
    const check = db.prepare("SELECT COUNT(*) as c FROM swarm_claims WHERE subject_ref = 'security'").get() as { c: number };
    expect(check.c).toBe(4);
    const directQuery = db.prepare("SELECT subject_ref, COUNT(*) as freq FROM swarm_claims WHERE claim_type = 'capability' AND created_at > datetime('now', '-30 days') GROUP BY subject_ref HAVING freq >= 3").all();
    expect(directQuery.length).toBe(1);
    const report = metaEvolution.evaluate();
    expect(report.synthesized_contracts).toBe(1);
  });

  it('does not synthesize for < 3 gaps', () => {
    db.prepare(`
      INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, predicate, status, confidence, evidence_refs_json, created_from, created_at, updated_at)
      VALUES ('gap-low-1', 'gap', 'capability', 'performance', 'gap', 'proposed', 0.5, '[]', 'test', datetime('now'), datetime('now'))
    `).run();
    const report = metaEvolution.evaluate();
    expect(report.synthesized_contracts).toBe(0);
  });

  it('creates draft capability with draft_loop_contract metadata', () => {
    for (let i = 0; i < 3; i++) {
      db.prepare(`
        INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, predicate, status, confidence, evidence_refs_json, created_from, created_at, updated_at)
        VALUES (?, 'gap', 'capability', 'testing', 'gap', 'proposed', 0.5, '[]', 'test', datetime('now'), datetime('now'))
      `).run('gap-test-' + i);
    }
    metaEvolution.evaluate();
    const cap = db.prepare("SELECT * FROM swarm_capabilities WHERE id = 'loop-contract-testing'").get() as any;
    expect(cap).toBeDefined();
    expect(cap.kind).toBe('deterministic_harness');
    const meta = JSON.parse(cap.metadata);
    expect(meta.draft_loop_contract).toBeDefined();
    expect(meta.synthesized_from).toBe('testing');
  });

  it('does not duplicate contracts for same gap domain', () => {
    for (let i = 0; i < 3; i++) {
      db.prepare(`
        INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, predicate, status, confidence, evidence_refs_json, created_from, created_at, updated_at)
        VALUES (?, 'gap', 'capability', 'architecture', 'gap', 'proposed', 0.5, '[]', 'test', datetime('now'), datetime('now'))
      `).run('gap-arch-' + i);
    }
    metaEvolution.evaluate();
    metaEvolution.evaluate();
    const count = db.prepare("SELECT COUNT(*) as c FROM swarm_capabilities WHERE id = 'loop-contract-architecture'").get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('report includes synthesized_contracts field', () => {
    const report = metaEvolution.evaluate();
    expect(report).toHaveProperty('synthesized_contracts');
  });
});
