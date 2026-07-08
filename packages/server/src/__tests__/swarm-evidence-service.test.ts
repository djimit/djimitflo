import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { SwarmEvidenceService } from '../services/swarm-evidence-service';

describe('SwarmEvidenceService', () => {
  let db: ReturnType<typeof createTestDb>;
  let evidence: SwarmEvidenceService;

  beforeEach(() => {
    db = createTestDb();
    // Drop table if exists to ensure clean schema (test-db helper may have older version)
    db.exec('DROP TABLE IF EXISTS swarm_evidence_edges');
    evidence = new SwarmEvidenceService(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates evidence edges', () => {
    const result = evidence.createEvidenceEdge('cap:1', 'claim:2', 'supports', { weight: 0.9 });
    expect(result.id).toBeDefined();
    expect(result.from_ref).toBe('cap:1');
    expect(result.to_ref).toBe('claim:2');
    expect(result.relation).toBe('supports');
    expect(result.metadata).toEqual({ weight: 0.9 });
  });

  it('rejects invalid edges', () => {
    expect(() => evidence.createEvidenceEdge('', 'claim:2', 'supports')).toThrow('SWARM_EVIDENCE_EDGE_INVALID');
    expect(() => evidence.createEvidenceEdge('cap:1', '', 'supports')).toThrow('SWARM_EVIDENCE_EDGE_INVALID');
    expect(() => evidence.createEvidenceEdge('cap:1', 'claim:2', '')).toThrow('SWARM_EVIDENCE_EDGE_INVALID');
  });

  it('trims whitespace from refs', () => {
    const result = evidence.createEvidenceEdge('  cap:1  ', '  claim:2  ', '  supports  ');
    expect(result.from_ref).toBe('cap:1');
    expect(result.to_ref).toBe('claim:2');
    expect(result.relation).toBe('supports');
  });

  it('resolves lineage forward', () => {
    evidence.createEvidenceEdge('a', 'b', 'supports');
    evidence.createEvidenceEdge('b', 'c', 'supports');
    evidence.createEvidenceEdge('c', 'd', 'supports');

    const result = evidence.lineageForward('a', 10);
    expect(result.ref).toBe('a');
    expect(result.edges.length).toBe(3);
    expect(result.edges[0].to).toBe('b');
    expect(result.edges[1].to).toBe('c');
    expect(result.edges[2].to).toBe('d');
  });

  it('resolves lineage reverse', () => {
    evidence.createEvidenceEdge('a', 'b', 'supports');
    evidence.createEvidenceEdge('b', 'c', 'supports');

    const result = evidence.lineageReverse('c', 10);
    expect(result.ref).toBe('c');
    expect(result.edges.length).toBe(2);
    expect(result.edges[0].from).toBe('b');
    expect(result.edges[1].from).toBe('a');
  });

  it('respects max depth', () => {
    evidence.createEvidenceEdge('a', 'b', 'supports');
    evidence.createEvidenceEdge('b', 'c', 'supports');
    evidence.createEvidenceEdge('c', 'd', 'supports');

    const result = evidence.lineageForward('a', 2);
    expect(result.edges.length).toBe(2); // b and c, not d
  });

  it('avoids cycles in lineage', () => {
    evidence.createEvidenceEdge('a', 'b', 'supports');
    evidence.createEvidenceEdge('b', 'a', 'contradicts'); // cycle

    const result = evidence.lineageForward('a', 10);
    expect(result.edges.length).toBe(1); // only b
  });

  it('provides graph summary', () => {
    evidence.createEvidenceEdge('a', 'b', 'supports');
    evidence.createEvidenceEdge('a', 'c', 'supports');
    evidence.createEvidenceEdge('d', 'a', 'contradicts');

    const summary = evidence.evidenceGraphSummary('a');
    expect(summary.forward_count).toBe(2);
    expect(summary.reverse_count).toBe(1);
    expect(summary.forward.length).toBe(2);
    expect(summary.reverse.length).toBe(1);
  });

  it('filters lineage by scope', () => {
    evidence.createEvidenceEdge('a', 'b', 'supports');
    evidence.createEvidenceEdge('a', 'c', 'supports');

    const scoped = evidence.lineageForwardScoped('a', new Set(['b']), 10);
    expect(scoped.edges.length).toBe(1);
    expect(scoped.edges[0].to).toBe('b');
  });

  it('allows wildcard scope', () => {
    evidence.createEvidenceEdge('a', 'b', 'supports');
    evidence.createEvidenceEdge('a', 'c', 'supports');

    const scoped = evidence.lineageForwardScoped('a', new Set(['*']), 10);
    expect(scoped.edges.length).toBe(2);
  });

  it('resolves evidence refs — all exist', () => {
    // Drop and recreate table with correct schema
    db.exec('DROP TABLE IF EXISTS swarm_capabilities');
    db.exec(`CREATE TABLE swarm_capabilities (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, owner TEXT NOT NULL, version TEXT NOT NULL,
      status TEXT NOT NULL, risk_ceiling TEXT NOT NULL, input_schema_ref TEXT, output_schema_ref TEXT,
      allowed_actions TEXT NOT NULL DEFAULT '[]', forbidden_actions TEXT NOT NULL DEFAULT '[]',
      required_evidence TEXT NOT NULL DEFAULT '[]', eval_score REAL NOT NULL DEFAULT 0,
      eval_threshold REAL NOT NULL DEFAULT 0, cost_model TEXT NOT NULL DEFAULT '{}',
      removal_strategy TEXT NOT NULL DEFAULT 'soft', latest_validation_report TEXT,
      metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.prepare(`INSERT INTO swarm_capabilities (id, kind, owner, version, status, risk_ceiling, allowed_actions, forbidden_actions, required_evidence, eval_score, eval_threshold, cost_model, removal_strategy, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('cap-1', 'skill', 'test', '1.0', 'validated', 'low', '[]', '[]', '[]', 0.8, 0.6, '{}', 'soft', '{}');

    const result = evidence.resolveEvidenceRefs(['capability:cap-1']);
    expect(result.all_resolved).toBe(true);
    expect(result.unresolved).toEqual([]);
  });

  it('resolves evidence refs — some missing', () => {
    const result = evidence.resolveEvidenceRefs(['capability:exists', 'capability:missing']);
    expect(result.all_resolved).toBe(false);
    expect(result.unresolved).toContain('capability:missing');
  });

  it('handles malformed refs gracefully', () => {
    const result = evidence.resolveEvidenceRefs(['malformed', 'no-colon-here']);
    expect(result.all_resolved).toBe(false);
    expect(result.unresolved.length).toBe(2);
  });

  it('extracts claims from panel metadata', () => {
    // This test verifies the method doesn't throw on empty results
    const result = evidence.extractClaimsFromPanel('nonexistent-panel');
    expect(result.extracted).toBe(0);
    expect(result.claims).toEqual([]);
  });
});
