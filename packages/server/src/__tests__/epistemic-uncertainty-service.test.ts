import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { EpistemicUncertaintyService } from '../services/epistemic-uncertainty-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let epistemic: EpistemicUncertaintyService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  epistemic = new EpistemicUncertaintyService(db);
});

afterEach(() => {
  db?.close();
});

describe('G67: Epistemic Uncertainty', () => {
  it('assesses high uncertainty for small samples', () => {
    const u = epistemic.assessUncertainty('new-cap', 2, 0.5);
    expect(u).toBeGreaterThan(0.3);
  });

  it('assesses low uncertainty for large samples', () => {
    const u = epistemic.assessUncertainty('known-cap', 100, 0.8);
    expect(u).toBeLessThan(0.3);
  });

  it('flags hallucination with no evidence', () => {
    const flags = epistemic.detectHallucinations('claim-1', []);
    expect(flags.length).toBeGreaterThan(0);
  });

  it('flags high confidence with low evidence', () => {
    db.prepare("INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, confidence, status, evidence_refs_json, created_from, created_at, updated_at) VALUES ('c1', 'test', 'memory', 'test', 0.95, 'proposed', '[]', 'test', datetime('now'), datetime('now'))").run();
    const flags = epistemic.detectHallucinations('c1', ['one-evidence']);
    expect(flags.length).toBeGreaterThan(0);
  });

  it('identifies knowledge gap', () => {
    const gap = epistemic.identifyKnowledgeGap('new-domain', 'Need to learn X');
    expect(gap.priority).toBeGreaterThan(0);
    expect(gap.status).toBe('open');
  });

  it('gets open knowledge gaps', () => {
    epistemic.identifyKnowledgeGap('d1', 'Learn A');
    epistemic.identifyKnowledgeGap('d2', 'Learn B');
    const gaps = epistemic.getKnowledgeGaps('open');
    expect(gaps.length).toBe(2);
  });

  it('addressGap updates status', () => {
    const gap = epistemic.identifyKnowledgeGap('d3', 'Learn C');
    epistemic.addressGap(gap.id);
    const gaps = epistemic.getKnowledgeGaps('addressing');
    expect(gaps.length).toBe(1);
  });

  it('closeGap updates status', () => {
    const gap = epistemic.identifyKnowledgeGap('d4', 'Learn D');
    epistemic.closeGap(gap.id);
    const gaps = epistemic.getKnowledgeGaps('closed');
    expect(gaps.length).toBe(1);
  });

  it('gets uncertainty history', () => {
    epistemic.assessUncertainty('h1', 5, 0.5);
    epistemic.assessUncertainty('h1', 10, 0.6);
    const history = epistemic.getUncertaintyHistory('h1');
    expect(history.length).toBe(2);
  });
});
