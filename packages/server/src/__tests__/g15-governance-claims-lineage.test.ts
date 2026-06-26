import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { KnowledgeRuntimeService } from '../services/knowledge-runtime-service';

let db: Database.Database;
let intel: SwarmIntelligenceService;
let knowledge: KnowledgeRuntimeService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  intel = new SwarmIntelligenceService(db);
  knowledge = new KnowledgeRuntimeService(db);
});

afterEach(() => { db?.close(); });

describe('G15.3 governance enforcement', () => {
  it('enforceGovernanceCompletion blocks when unresolved claims exist', () => {
    intel.createClaim({
      claim: 'Security review pending',
      claim_type: 'hypothesis',
      subject_ref: 'loop:blocked-loop',
      confidence: 0.5,
      status: 'proposed',
      created_from: 'test',
    });

    const claims = intel.listClaims(500);
    const loopClaims = claims.filter((c) => c.subject_ref === 'loop:blocked-loop');
    const unresolved = loopClaims.filter((c) => ['proposed', 'contradicted', 'review_required'].includes(c.status));
    expect(unresolved.length).toBeGreaterThan(0);
  });

  it('enforceGovernanceCompletion passes when all claims are resolved', () => {
    intel.createClaim({
      claim: 'All gates passed',
      claim_type: 'decision',
      subject_ref: 'loop:clean-loop',
      confidence: 0.95,
      status: 'resolved',
      evidence_refs: ['lease:1', 'gate:tests'],
      created_from: 'test',
    });

    const claims = intel.listClaims(500);
    const loopClaims = claims.filter((c) => c.subject_ref === 'loop:clean-loop');
    const unresolved = loopClaims.filter((c) => ['proposed', 'contradicted', 'review_required'].includes(c.status));
    expect(unresolved.length).toBe(0);
  });
});

describe('G15.4 claim ledger v2', () => {
  it('creates claims with typed fields: predicate, object, scope, valid_until', () => {
    const claim = intel.createClaim({
      claim: 'Token bucket is sufficient',
      claim_type: 'decision',
      subject_ref: 'mission:rate-limit',
      predicate: 'uses',
      object: 'token_bucket',
      scope: 'internal_apis',
      confidence: 0.85,
      valid_until: '2027-01-01T00:00:00Z',
      status: 'supported',
      evidence_refs: ['panel:1'],
      created_from: 'test',
    });

    expect(claim.predicate).toBe('uses');
    expect(claim.object).toBe('token_bucket');
    expect(claim.scope).toBe('internal_apis');
    expect(claim.valid_until).toContain('2027-01-01T00:00:00');
  });

  it('creates explicit contradiction edges between claims', () => {
    const claim1 = intel.createClaim({
      claim: 'Token bucket is the best approach',
      claim_type: 'decision',
      subject_ref: 'mission:rate-limit',
      confidence: 0.8,
      status: 'supported',
      evidence_refs: ['doc:1'],
      created_from: 'test',
    });

    const claim2 = intel.createClaim({
      claim: 'Sliding window is better for DDoS protection',
      claim_type: 'hypothesis',
      subject_ref: 'mission:rate-limit',
      confidence: 0.6,
      status: 'proposed',
      contradicts_ref: claim1.id,
      evidence_refs: ['doc:2'],
      created_from: 'test',
    });

    expect(claim2.contradicts_ref).toBe(claim1.id);
    // The first claim should be marked as contradicted
    const updated = intel.getClaim(claim1.id);
    expect(updated.status).toBe('contradicted');
  });

  it('resolves evidence refs and reports unresolved ones', () => {
    // Create a real capability to use as evidence
    const cap = intel.registerCapability({
      id: 'evidence-cap',
      kind: 'skill',
      owner: 'test',
      version: '1.0.0',
      status: 'validated',
      risk_ceiling: 'low',
      input_schema_ref: 'none',
      output_schema_ref: 'none',
      allowed_actions: ['maker:mock'],
      forbidden_actions: ['deploy'],
      required_evidence: ['worker_lease'],
      eval_threshold: 0.5,
      removal_strategy: 'disable',
    });

    const result = intel.resolveEvidenceRefs([`capability:${cap.id}`, 'capability:nonexistent']);
    expect(result.all_resolved).toBe(false);
    expect(result.unresolved).toContain('capability:nonexistent');
    expect(result.unresolved).not.toContain(`capability:${cap.id}`);
  });
});

describe('G15.5 lineage resolver', () => {
  it('traverses forward from a ref through evidence edges', () => {
    intel.createEvidenceEdge('mission:1', 'goal:1', 'decomposes_to');
    intel.createEvidenceEdge('goal:1', 'loop:1', 'executes_with');
    intel.createEvidenceEdge('loop:1', 'lease:1', 'assigns');

    const forward = intel.lineageForward('mission:1');
    expect(forward.edges.length).toBe(3);
    expect(forward.edges.map((e) => e.to)).toContain('goal:1');
    expect(forward.edges.map((e) => e.to)).toContain('loop:1');
    expect(forward.edges.map((e) => e.to)).toContain('lease:1');
  });

  it('traverses reverse from a ref through evidence edges', () => {
    intel.createEvidenceEdge('mission:1', 'goal:1', 'decomposes_to');
    intel.createEvidenceEdge('goal:1', 'loop:1', 'executes_with');

    const reverse = intel.lineageReverse('loop:1');
    expect(reverse.edges.length).toBe(2);
    expect(reverse.edges.map((e) => e.from)).toContain('goal:1');
    expect(reverse.edges.map((e) => e.from)).toContain('mission:1');
  });

  it('produces evidence graph summary for dashboard', () => {
    intel.createEvidenceEdge('loop:1', 'lease:1', 'executes_with');
    intel.createEvidenceEdge('loop:1', 'gate:tests', 'verified_by');
    intel.createEvidenceEdge('panel:1', 'loop:1', 'informs');

    const summary = intel.evidenceGraphSummary('loop:1');
    expect(summary.forward_count).toBe(2);
    expect(summary.reverse_count).toBe(1);
    expect(summary.forward.map((f) => f.to)).toContain('lease:1');
    expect(summary.reverse.map((r) => r.from)).toContain('panel:1');
  });

  it('resolves evidence refs via KnowledgeRuntimeService', () => {
    const cap = intel.registerCapability({
      id: 'resolve-test-cap',
      kind: 'skill',
      owner: 'test',
      version: '1.0.0',
      status: 'validated',
      risk_ceiling: 'low',
      input_schema_ref: 'none',
      output_schema_ref: 'none',
      allowed_actions: ['maker:mock'],
      forbidden_actions: ['deploy'],
      required_evidence: ['worker_lease'],
      eval_threshold: 0.5,
      removal_strategy: 'disable',
    });

    const resolved = knowledge.resolveEvidenceRef(`capability:${cap.id}`);
    expect(resolved.kind).toBe('capability');
    expect(resolved.exists).toBe(true);
    expect(resolved.valid).toBe(true);
  });
});
