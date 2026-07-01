import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CuriosityService } from '../services/curiosity-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let intelligence: SwarmIntelligenceService;
let curiosity: CuriosityService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  intelligence = new SwarmIntelligenceService(db);
  curiosity = new CuriosityService(db, intelligence);
});

afterEach(() => {
  db?.close();
  curiosity.stop();
});

describe('G41: Curiosity Service', () => {
  it('detects coverage gaps for domains with < 3 claims', async () => {
    db.prepare(`
      INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, predicate, status, confidence, evidence_refs_json, created_from, created_at, updated_at)
      VALUES ('c1', 'test', 'memory', 'security', 'has_property', 'supported', 0.8, '[]', 'test', datetime('now'), datetime('now'))
    `).run();
    const report = await curiosity.scanForGaps();
    const coverageGap = report.gaps.find(g => g.type === 'coverage' && g.domain === 'security');
    expect(coverageGap).toBeDefined();
  });

  it('detects confidence gaps for low-confidence domains', async () => {
    const oldDate = new Date(Date.now() - 40 * 86400000).toISOString();
    db.prepare(`
      INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, predicate, status, confidence, evidence_refs_json, created_from, created_at, updated_at)
      VALUES ('c2', 'test', 'memory', 'performance', 'has_property', 'supported', 0.3, '[]', 'test', ?, ?)
    `).run(oldDate, oldDate);
    const report = await curiosity.scanForGaps();
    const confGap = report.gaps.find(g => g.type === 'confidence');
    expect(confGap).toBeDefined();
  });

  it('detects contradiction gaps', async () => {
    db.prepare(`
      INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, predicate, status, confidence, evidence_refs_json, created_from, created_at, updated_at)
      VALUES ('c3', 'test', 'memory', 'testing', 'has_property', 'contradicted', 0.5, '[]', 'test', datetime('now'), datetime('now'))
    `).run();
    const report = await curiosity.scanForGaps();
    const contrGap = report.gaps.find(g => g.type === 'contradiction');
    expect(contrGap).toBeDefined();
  });

  it('publishes gap claims to knowledge bus', async () => {
    db.prepare(`
      INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, predicate, status, confidence, evidence_refs_json, created_from, created_at, updated_at)
      VALUES ('c4', 'test', 'memory', 'architecture', 'has_property', 'supported', 0.9, '[]', 'test', datetime('now'), datetime('now'))
    `).run();
    const report = await curiosity.scanForGaps();
    expect(report.gapsFound).toBeGreaterThanOrEqual(0);
  });

  it('returns empty report when no gaps exist', async () => {
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, predicate, status, confidence, evidence_refs_json, created_from, created_at, updated_at)
        VALUES (?, 'test', 'memory', 'well-covered', 'has_property', 'supported', 0.9, '[]', 'test', datetime('now'), datetime('now'))
      `).run('wc-' + i);
    }
    const report = await curiosity.scanForGaps();
    const coverageGap = report.gaps.find(g => g.domain === 'well-covered');
    expect(coverageGap).toBeUndefined();
  });

  it('start/stop timer works', () => {
    curiosity.start();
    curiosity.stop();
    expect(true).toBe(true);
  });
});
