import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { DAGConsensusService } from '../services/dag-consensus-service';
import { createTestDb } from './helpers/test-db';


let db: Database.Database;
let consensus: DAGConsensusService;

beforeEach(() => {
  db = createTestDb();
  db.pragma('foreign_keys = ON');
  
  
  consensus = new DAGConsensusService(db);
});

afterEach(() => {
  db?.close();
});

function insertClaim(id: string, confidence: number = 0.5, status: string = 'proposed') {
  db.prepare(`
    INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, status, confidence, evidence_refs_json, created_from, created_at, updated_at)
    VALUES (?, 'test', 'memory', 'test', ?, ?, '[]', 'test', datetime('now'), datetime('now'))
  `).run(id, status, confidence);
}

function insertEdge(from: string, to: string, relation: string) {
  db.prepare(`
    INSERT INTO swarm_evidence_edges (id, from_ref, to_ref, relation, metadata_json, created_at)
    VALUES (?, ?, ?, ?, '{}', datetime('now'))
  `).run(`edge-${from}-${to}`, from, to, relation);
}

describe('G49: DAG Consensus', () => {
  it('returns pending for claim with no edges', () => {
    insertClaim('lonely');
    const result = consensus.resolveConsensus('lonely');
    expect(result.status).toBe('pending');
  });

  it('confirms claim with strong support', () => {
    insertClaim('supported', 0.9);
    insertClaim('supporter1', 0.9);
    insertClaim('supporter2', 0.8);
    insertEdge('supporter1', 'supported', 'supports');
    insertEdge('supporter2', 'supported', 'supports');
    const result = consensus.resolveConsensus('supported');
    expect(result.status).toBe('confirmed');
  });

  it('falsifies claim with strong contradiction', () => {
    insertClaim('falsified', 0.3);
    insertClaim('contradictor1', 0.9);
    insertClaim('contradictor2', 0.8);
    insertEdge('contradictor1', 'falsified', 'contradicts');
    insertEdge('contradictor2', 'falsified', 'contradicts');
    const result = consensus.resolveConsensus('falsified');
    expect(result.status).toBe('falsified');
  });

  it('marks contested when evidence is balanced', () => {
    insertClaim('contested', 0.5);
    insertClaim('supporter', 0.5);
    insertClaim('contradictor', 0.5);
    insertEdge('supporter', 'contested', 'supports');
    insertEdge('contradictor', 'contested', 'contradicts');
    const result = consensus.resolveConsensus('contested');
    expect(result.status).toBe('contested');
  });

  it('source confidence influences consensus', () => {
    insertClaim('weighted', 0.5);
    insertClaim('weak-support', 0.3);
    insertClaim('strong-contradict', 0.9);
    insertEdge('weak-support', 'weighted', 'supports');
    insertEdge('strong-contradict', 'weighted', 'contradicts');
    const result = consensus.resolveConsensus('weighted');
    expect(result.contradictWeight).toBeGreaterThan(result.supportWeight);
  });

  it('runConsensusRound processes all claims', () => {
    insertClaim('c1', 0.9);
    insertClaim('c2', 0.3);
    insertClaim('supporter', 0.9);
    insertClaim('contradictor', 0.9);
    insertEdge('supporter', 'c1', 'supports');
    insertEdge('contradictor', 'c2', 'contradicts');
    const round = consensus.runConsensusRound();
    expect(round.confirmed).toBe(1);
    expect(round.falsified).toBe(1);
  });

  it('getConsensusStatus returns current status', () => {
    insertClaim('status-test', 0.5, 'supported');
    expect(consensus.getConsensusStatus('status-test')).toBe('confirmed');
  });

  it('getConfidence returns claim confidence', () => {
    insertClaim('conf-test', 0.85);
    expect(consensus.getConfidence('conf-test')).toBe(0.85);
  });

  it('byzantine tolerance: tolerates < 1/3 malicious', () => {
    expect(consensus.getByzantineTolerance(10, 2)).toBe(true);
    expect(consensus.getByzantineTolerance(10, 4)).toBe(false);
    expect(consensus.getByzantineTolerance(3, 0)).toBe(true);
    expect(consensus.getByzantineTolerance(3, 1)).toBe(false);
  });

  it('confirms with single strong supporter', () => {
    insertClaim('single', 0.5);
    insertClaim('strong', 0.95);
    insertEdge('strong', 'single', 'supports');
    const result = consensus.resolveConsensus('single');
    expect(result.status).toBe('confirmed');
  });

  it('updates claim status in DB', () => {
    insertClaim('update-me', 0.9, 'proposed');
    insertClaim('supporter-u', 0.9);
    insertEdge('supporter-u', 'update-me', 'supports');
    consensus.resolveConsensus('update-me');
    const status = consensus.getConsensusStatus('update-me');
    expect(status).toBe('confirmed');
  });

  it('confidence is between 0 and 1', () => {
    insertClaim('conf-range', 0.5);
    insertClaim('s1', 0.9);
    insertClaim('c1', 0.3);
    insertEdge('s1', 'conf-range', 'supports');
    insertEdge('c1', 'conf-range', 'contradicts');
    const result = consensus.resolveConsensus('conf-range');
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('handles non-existent claim gracefully', () => {
    const result = consensus.resolveConsensus('nonexistent');
    expect(result.status).toBe('pending');
    expect(result.confidence).toBe(0);
  });
});
