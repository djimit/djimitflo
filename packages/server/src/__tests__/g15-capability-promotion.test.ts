import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';

let db: Database.Database;
let svc: SwarmIntelligenceService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  svc = new SwarmIntelligenceService(db);
});

afterEach(() => { db?.close(); });

describe('G15.2 capability promotion', () => {
  it('creates a candidate that cannot route live workers', () => {
    const candidate = svc.createCandidate({
      id: 'candidate-skill',
      kind: 'skill',
      owner: 'test',
      version: '0.1.0',
      risk_ceiling: 'low',
      input_schema_ref: 'none',
      output_schema_ref: 'none',
      allowed_actions: ['maker:mock'],
      forbidden_actions: ['deploy'],
      required_evidence: ['worker_lease'],
      eval_threshold: 0.75,
      removal_strategy: 'disable if eval fails',
    });

    expect(candidate.status).toBe('candidate');
    expect(candidate.live_route_allowed).toBe(false);
  });

  it('promotes a low-risk candidate to validated with evidence refs', () => {
    svc.createCandidate({
      id: 'promotable-skill',
      kind: 'skill',
      owner: 'test',
      version: '0.1.0',
      risk_ceiling: 'low',
      input_schema_ref: 'none',
      output_schema_ref: 'none',
      allowed_actions: ['maker:mock'],
      forbidden_actions: ['deploy'],
      required_evidence: ['worker_lease'],
      eval_threshold: 0.75,
      removal_strategy: 'disable if eval fails',
    });

    const promoted = svc.promoteCapability('promotable-skill', {
      eval_score: 0.9,
      evidence_refs: ['eval_run:test-1', 'trace:test-2'],
      validation_report: 'All checks passed',
    });

    expect(promoted.status).toBe('validated');
    expect(promoted.eval_score).toBe(0.9);
    expect(promoted.live_route_allowed).toBe(true);
  });

  it('blocks promotion when eval score is below threshold', () => {
    svc.createCandidate({
      id: 'low-score-skill',
      kind: 'skill',
      owner: 'test',
      version: '0.1.0',
      risk_ceiling: 'low',
      input_schema_ref: 'none',
      output_schema_ref: 'none',
      allowed_actions: ['maker:mock'],
      forbidden_actions: ['deploy'],
      required_evidence: ['worker_lease'],
      eval_threshold: 0.75,
      removal_strategy: 'disable',
    });

    expect(() => svc.promoteCapability('low-score-skill', {
      eval_score: 0.5,
      evidence_refs: ['eval:1'],
    })).toThrow(/CAPABILITY_BELOW_EVAL_THRESHOLD/);
  });

  it('blocks promotion without evidence refs', () => {
    svc.createCandidate({
      id: 'no-evidence-skill',
      kind: 'skill',
      owner: 'test',
      version: '0.1.0',
      risk_ceiling: 'low',
      input_schema_ref: 'none',
      output_schema_ref: 'none',
      allowed_actions: ['maker:mock'],
      forbidden_actions: ['deploy'],
      required_evidence: ['worker_lease'],
      eval_threshold: 0.5,
      removal_strategy: 'disable',
    });

    expect(() => svc.promoteCapability('no-evidence-skill', {
      eval_score: 0.9,
    })).toThrow(/CAPABILITY_PROMOTION_EVIDENCE_REQUIRED/);
  });

  it('requires security checker and human approval for high-risk promotion', () => {
    svc.createCandidate({
      id: 'high-risk-skill',
      kind: 'skill',
      owner: 'test',
      version: '0.1.0',
      risk_ceiling: 'high',
      input_schema_ref: 'none',
      output_schema_ref: 'none',
      allowed_actions: ['maker:codex', 'deploy'],
      forbidden_actions: ['modify_secrets'],
      required_evidence: ['worker_lease', 'checker_verdict'],
      eval_threshold: 0.8,
      removal_strategy: 'disable and review',
    });

    // Without security checker
    expect(() => svc.promoteCapability('high-risk-skill', {
      eval_score: 0.9,
      evidence_refs: ['eval:1'],
    })).toThrow(/CAPABILITY_PROMOTION_SECURITY_CHECKER_REQUIRED/);

    // With security checker but without human approval
    expect(() => svc.promoteCapability('high-risk-skill', {
      eval_score: 0.9,
      evidence_refs: ['eval:1'],
      security_checker_ref: 'checker:abc',
    })).toThrow(/CAPABILITY_PROMOTION_HUMAN_APPROVAL_REQUIRED/);

    // With both
    const promoted = svc.promoteCapability('high-risk-skill', {
      eval_score: 0.9,
      evidence_refs: ['eval:1', 'eval:2'],
      security_checker_ref: 'checker:abc',
      human_approval_ref: 'approval:def',
    });
    expect(promoted.status).toBe('validated');
  });
});
