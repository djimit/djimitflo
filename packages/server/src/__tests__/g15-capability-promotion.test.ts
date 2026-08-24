import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';

let db: Database.Database;
let svc: SwarmIntelligenceService;
let runnerDir: string;
let previousRunner: string | undefined;

function writeRunner(name: string, source: string) {
  const file = join(runnerDir, name);
  writeFileSync(file, source, 'utf8');
  return file;
}

function seedSkillEvidence(skillId: string, candidateHash = 'candidate-hash', baselineHash = 'baseline-hash', candidateSuccesses = 30) {
  const insert = db.prepare(`
    INSERT INTO skill_outcomes (
      id, skill_id, success, tokens_used, duration_ms, domain, skill_version, skill_content_hash, evidence_refs_json
    ) VALUES (?, ?, ?, ?, ?, 'test', '0.1.0', ?, '[]')
  `);
  for (let i = 0; i < 30; i += 1) {
    insert.run(`baseline-${skillId}-${i}`, skillId, i < 24 ? 1 : 0, 1_000, 1_000, baselineHash);
    insert.run(`candidate-${skillId}-${i}`, skillId, i < candidateSuccesses ? 1 : 0, 800, 800, candidateHash);
  }
  db.prepare(`
    INSERT INTO openmythos_eval_runs (
      id, agent_id, total_cases, completed_cases, overall_score, status, metadata, started_at, finished_at
    ) VALUES (?, ?, 18, 18, 4.5, 'completed', ?, datetime('now'), datetime('now'))
  `).run(`eval-${skillId}`, skillId, JSON.stringify({
    evaluation_mode: 'skill_conditioned_prompt',
    skill_id: skillId,
    skill_version: '0.1.0',
    skill_content_hash: candidateHash,
    certification_eligible: true,
    score_valid: true,
  }));
  return {
    baseline_skill_content_hash: baselineHash,
    evidence_refs: [`skill_outcomes:${skillId}:${candidateHash}`, `openmythos:eval-${skillId}`],
  };
}

beforeEach(() => {
  previousRunner = process.env.DJIMIT_SKILL_TRAINING_EVAL_RUNNER;
  runnerDir = mkdtempSync(join(tmpdir(), 'skill-training-gate-'));
  process.env.DJIMIT_SKILL_TRAINING_EVAL_RUNNER = writeRunner('pass.mjs', 'console.log(JSON.stringify({ passed: true, summary: { generated_at: "test" } }));\n');
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  new SkillEvolutionEngine(db);
  svc = new SwarmIntelligenceService(db);
});

afterEach(() => {
  db?.close();
  if (previousRunner === undefined) delete process.env.DJIMIT_SKILL_TRAINING_EVAL_RUNNER;
  else process.env.DJIMIT_SKILL_TRAINING_EVAL_RUNNER = previousRunner;
  rmSync(runnerDir, { recursive: true, force: true });
});

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
      metadata: { agent_skill_id: 'promotable-skill', agent_skill_version: '0.1.0', agent_skill_content_hash: 'candidate-hash' },
    });

    const evidence = seedSkillEvidence('promotable-skill');

    const promoted = svc.promoteCapability('promotable-skill', {
      eval_score: 0.9,
      ...evidence,
      validation_report: 'All checks passed',
    });

    expect(promoted.status).toBe('validated');
    expect(promoted.eval_score).toBe(0.9);
    expect(promoted.live_route_allowed).toBe(true);
    expect(promoted.metadata.promotion_skill_training_gate_ref).toBe('skill_training_eval:test');
    expect(promoted.metadata.promotion_skill_comparison).toMatchObject({
      candidate_runs: 30,
      baseline_runs: 30,
      candidate_success_rate: 1,
      baseline_success_rate: 0.8,
      openmythos_run_id: 'eval-promotable-skill',
    });
  });

  it('reports exact promotion readiness without running the final training gate', () => {
    svc.createCandidate({
      id: 'ready-skill', kind: 'skill', owner: 'test', version: '0.1.0', risk_ceiling: 'low',
      input_schema_ref: 'none', output_schema_ref: 'none', allowed_actions: ['maker:mock'],
      forbidden_actions: ['deploy'], required_evidence: ['worker_lease'], eval_threshold: 0.75,
      removal_strategy: 'disable',
      metadata: { agent_skill_id: 'ready-skill', agent_skill_version: '0.1.0', agent_skill_content_hash: 'candidate-hash' },
    });
    seedSkillEvidence('ready-skill');

    expect(svc.skillEvolutionReadiness()).toContainEqual(expect.objectContaining({
      capability_id: 'ready-skill',
      candidate_runs: 30,
      evidence_ready: true,
      openmythos_run_id: 'eval-ready-skill',
      promotion_input: expect.objectContaining({
        eval_score: 0.9,
        baseline_skill_content_hash: 'baseline-hash',
      }),
    }));
  });

  it('blocks skill promotion when the training gate fails', () => {
    process.env.DJIMIT_SKILL_TRAINING_EVAL_RUNNER = writeRunner('fail.mjs', 'console.log(JSON.stringify({ passed: false, threshold_failures: ["regression"] })); process.exit(1);\n');
    svc.createCandidate({
      id: 'gate-blocked-skill',
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
      metadata: { agent_skill_id: 'gate-blocked-skill', agent_skill_version: '0.1.0', agent_skill_content_hash: 'candidate-hash' },
    });

    const evidence = seedSkillEvidence('gate-blocked-skill');

    expect(() => svc.promoteCapability('gate-blocked-skill', {
      eval_score: 0.9,
      ...evidence,
      validation_report: 'local evidence passed',
    })).toThrow(/SKILL_TRAINING_PROMOTION_GATE_FAILED/);
  });

  it('blocks a skill candidate that does not measurably beat its baseline', () => {
    svc.createCandidate({
      id: 'regressed-skill', kind: 'skill', owner: 'test', version: '0.1.0', risk_ceiling: 'low',
      input_schema_ref: 'none', output_schema_ref: 'none', allowed_actions: ['maker:mock'],
      forbidden_actions: ['deploy'], required_evidence: ['worker_lease'], eval_threshold: 0.75,
      removal_strategy: 'disable',
      metadata: { agent_skill_id: 'regressed-skill', agent_skill_version: '0.1.0', agent_skill_content_hash: 'candidate-hash' },
    });
    const evidence = seedSkillEvidence('regressed-skill', 'candidate-hash', 'baseline-hash', 20);

    expect(() => svc.promoteCapability('regressed-skill', { eval_score: 0.9, ...evidence }))
      .toThrow('CAPABILITY_PROMOTION_SKILL_NO_MEASURABLE_IMPROVEMENT');
    expect(svc.skillEvolutionReadiness().find((item) => item.capability_id === 'regressed-skill')).toMatchObject({
      evidence_ready: false,
      blocked_reasons: ['CAPABILITY_PROMOTION_SKILL_NO_MEASURABLE_IMPROVEMENT'],
    });
  });

  it('blocks skill promotion without exact skill attribution', () => {
    svc.createCandidate({
      id: 'unattributed-skill', kind: 'skill', owner: 'test', version: '0.1.0', risk_ceiling: 'low',
      input_schema_ref: 'none', output_schema_ref: 'none', allowed_actions: ['maker:mock'],
      forbidden_actions: ['deploy'], required_evidence: ['worker_lease'], eval_threshold: 0.75,
      removal_strategy: 'disable',
    });

    expect(() => svc.promoteCapability('unattributed-skill', {
      eval_score: 0.9,
      evidence_refs: ['eval:1'],
      baseline_skill_content_hash: 'baseline-hash',
    })).toThrow('CAPABILITY_PROMOTION_SKILL_ATTRIBUTION_REQUIRED');
  });

  it('keeps automatic skill promotion behind the explicit comparison gate', () => {
    svc.createCandidate({
      id: 'explicit-only-skill', kind: 'skill', owner: 'test', version: '0.1.0', risk_ceiling: 'low',
      input_schema_ref: 'none', output_schema_ref: 'none', allowed_actions: ['maker:mock'],
      forbidden_actions: ['deploy'], required_evidence: ['worker_lease'], eval_threshold: 0.75,
      removal_strategy: 'disable',
      metadata: { agent_skill_id: 'explicit-only-skill', agent_skill_version: '0.1.0', agent_skill_content_hash: 'candidate-hash' },
    });

    expect(svc.autoPromoteFromEvidence('explicit-only-skill')).toMatchObject({
      promoted: false,
      reason: 'skill promotion requires an explicit baseline and exact OpenMythos evidence',
    });
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
      id: 'high-risk-adapter',
      kind: 'runtime_adapter',
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
    expect(() => svc.promoteCapability('high-risk-adapter', {
      eval_score: 0.9,
      evidence_refs: ['eval:1'],
    })).toThrow(/CAPABILITY_PROMOTION_SECURITY_CHECKER_REQUIRED/);

    // With security checker but without human approval
    expect(() => svc.promoteCapability('high-risk-adapter', {
      eval_score: 0.9,
      evidence_refs: ['eval:1'],
      security_checker_ref: 'checker:abc',
    })).toThrow(/CAPABILITY_PROMOTION_HUMAN_APPROVAL_REQUIRED/);

    // With both
    const promoted = svc.promoteCapability('high-risk-adapter', {
      eval_score: 0.9,
      evidence_refs: ['eval:1', 'eval:2'],
      security_checker_ref: 'checker:abc',
      human_approval_ref: 'approval:def',
    });
    expect(promoted.status).toBe('validated');
  });
});
