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

/** Outcomes carry the engine's positive delivery evidence (INT-004) unless `refs` says otherwise. */
function seedSkillEvidence(skillId: string, candidateHash = 'candidate-hash', baselineHash = 'baseline-hash', candidateSuccesses = 30,
  candidateTokens: number | null = 800, candidateDurationMs = 800, refs = '["skill_delivery:delivered"]') {
  const insert = db.prepare(`
    INSERT INTO skill_outcomes (
      id, skill_id, success, tokens_used, duration_ms, domain, skill_version, skill_content_hash, evidence_refs_json
    ) VALUES (?, ?, ?, ?, ?, 'test', '0.1.0', ?, '${refs}')
  `);
  for (let i = 0; i < 30; i += 1) {
    insert.run(`baseline-${skillId}-${i}`, skillId, i < 24 ? 1 : 0, 1_000, 1_000, baselineHash);
    insert.run(`candidate-${skillId}-${i}`, skillId, i < candidateSuccesses ? 1 : 0, candidateTokens, candidateDurationMs, candidateHash);
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

  it('compares immutable versions using an explicit compatible baseline capability', () => {
    const common = { kind: 'skill' as const, owner: 'test', risk_ceiling: 'low' as const,
      input_schema_ref: 'input', output_schema_ref: 'output', allowed_actions: ['Bash'],
      forbidden_actions: ['deploy'], required_evidence: ['verified-task'], removal_strategy: 'disable' };
    const contract = { format: 1, capabilities: ['counter'], input: { type: 'object' }, output: { type: 'object' }, dependencies: [] };
    svc.createCandidate({ ...common, id: 'baseline', version: '0.0.1', metadata: {
      package_hash: 'b'.repeat(64), agent_skill_id: 'counter-v0-0-1', agent_skill_version: '0.0.1', agent_skill_content_hash: 'baseline-hash',
      executable_skill: { ...contract, id: 'counter-v0-0-1', version: '0.0.1' },
    } });
    svc.createCandidate({ ...common, id: 'candidate', version: '0.1.0', metadata: {
      package_hash: 'c'.repeat(64), agent_skill_id: 'counter-v0-1-0', agent_skill_version: '0.1.0', agent_skill_content_hash: 'candidate-hash',
      executable_skill: { ...contract, id: 'counter-v0-1-0', version: '0.1.0' },
    } });
    const evidence = seedSkillEvidence('counter-v0-1-0');
    db.prepare("UPDATE skill_outcomes SET skill_id='counter-v0-0-1' WHERE skill_content_hash='baseline-hash'").run();
    db.prepare("UPDATE skill_outcomes SET evidence_refs_json=? WHERE skill_content_hash='baseline-hash'").run(JSON.stringify(['skill_delivery:delivered', `skill_package_sha256:${'b'.repeat(64)}`]));
    db.prepare("UPDATE skill_outcomes SET evidence_refs_json=? WHERE skill_content_hash='candidate-hash'").run(JSON.stringify(['skill_delivery:delivered', `skill_package_sha256:${'c'.repeat(64)}`]));
    const input = { ...evidence, evidence_refs: [...evidence.evidence_refs, 'skill_outcomes:counter-v0-0-1:baseline-hash'], eval_score: 1, baseline_capability_id: 'baseline' };
    expect(() => svc.promoteCapability('candidate', { ...input, baseline_skill_content_hash: 'wrong' })).toThrow('CAPABILITY_PROMOTION_SKILL_BASELINE_MISMATCH');
    db.prepare("UPDATE swarm_capabilities SET allowed_actions_json='[\"Network\"]' WHERE id='baseline'").run();
    expect(() => svc.promoteCapability('candidate', input)).toThrow('CAPABILITY_PROMOTION_SKILL_BASELINE_MISMATCH');
    db.prepare("UPDATE swarm_capabilities SET allowed_actions_json='[\"Bash\"]' WHERE id='baseline'").run();
    db.prepare("UPDATE skill_outcomes SET evidence_refs_json='[\"skill_delivery:delivered\",\"outcome_class:completed_unverified\"]' WHERE skill_content_hash='candidate-hash'").run();
    expect(() => svc.promoteCapability('candidate', input)).toThrow('candidate=0:baseline=30:minimum=30');
    db.prepare("UPDATE skill_outcomes SET evidence_refs_json=? WHERE skill_content_hash='candidate-hash'").run(JSON.stringify(['skill_delivery:delivered', `skill_package_sha256:${'c'.repeat(64)}`]));
    expect(svc.skillEvolutionReadiness().find((row) => row.capability_id === 'candidate')?.promotion_input).toMatchObject({ baseline_capability_id: 'baseline' });
    const promoted = svc.promoteCapability('candidate', input);
    expect(promoted.metadata.promotion_skill_comparison).toMatchObject({
      baseline_capability_id: 'baseline', baseline_skill_id: 'counter-v0-0-1', candidate_runs: 30, baseline_runs: 30,
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

  it('counts only verified skill attribution as promotion evidence (INT-004 follow-up)', () => {
    svc.createCandidate({
      id: 'unverified-skill', kind: 'skill', owner: 'test', version: '0.1.0', risk_ceiling: 'low',
      input_schema_ref: 'none', output_schema_ref: 'none', allowed_actions: ['maker:mock'],
      forbidden_actions: ['deploy'], required_evidence: ['worker_lease'], eval_threshold: 0.75,
      removal_strategy: 'disable',
      metadata: { agent_skill_id: 'unverified-skill', agent_skill_version: '0.1.0', agent_skill_content_hash: 'candidate-hash' },
    });
    const evidence = seedSkillEvidence('unverified-skill');
    // the engine's assigned-but-not-delivered tags: the skill was assigned, the runtime never provably got it
    db.prepare(`UPDATE skill_outcomes SET evidence_refs_json = '["skill_delivery:assigned","skill_attribution:unverified"]'
      WHERE skill_id = 'unverified-skill' AND skill_content_hash = 'candidate-hash'`).run();

    expect(() => svc.promoteCapability('unverified-skill', { eval_score: 0.9, ...evidence }))
      .toThrow('CAPABILITY_PROMOTION_SKILL_OUTCOMES_REQUIRED:candidate=0:baseline=30:minimum=30');
    expect(svc.skillEvolutionReadiness().find((item) => item.capability_id === 'unverified-skill')).toMatchObject({
      candidate_runs: 0, evidence_ready: false,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM skill_outcomes WHERE skill_id = 'unverified-skill'").get()).toEqual({ n: 60 }); // still stored
  });

  it('rejects untagged (legacy, no delivery evidence) candidate and baseline outcomes as promotion evidence', () => {
    svc.createCandidate({
      id: 'legacy-skill', kind: 'skill', owner: 'test', version: '0.1.0', risk_ceiling: 'low',
      input_schema_ref: 'none', output_schema_ref: 'none', allowed_actions: ['maker:mock'],
      forbidden_actions: ['deploy'], required_evidence: ['worker_lease'], eval_threshold: 0.75,
      removal_strategy: 'disable',
      metadata: { agent_skill_id: 'legacy-skill', agent_skill_version: '0.1.0', agent_skill_content_hash: 'candidate-hash' },
    });
    const evidence = seedSkillEvidence('legacy-skill', 'candidate-hash', 'baseline-hash', 30, 800, 800, '[]');

    expect(() => svc.promoteCapability('legacy-skill', { eval_score: 0.9, ...evidence }))
      .toThrow('CAPABILITY_PROMOTION_SKILL_OUTCOMES_REQUIRED:candidate=0:baseline=0:minimum=30');
    expect(svc.skillEvolutionReadiness().find((item) => item.capability_id === 'legacy-skill')).toMatchObject({
      candidate_runs: 0, evidence_ready: false, blocked_reasons: ['CAPABILITY_PROMOTION_SKILL_BASELINE_REQUIRED'],
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM skill_outcomes WHERE skill_id = 'legacy-skill'").get()).toEqual({ n: 60 }); // still stored
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

  it('does not read unknown (null) token usage as a token saving', () => {
    svc.createCandidate({
      id: 'unknown-tokens-skill', kind: 'skill', owner: 'test', version: '0.1.0', risk_ceiling: 'low',
      input_schema_ref: 'none', output_schema_ref: 'none', allowed_actions: ['maker:mock'],
      forbidden_actions: ['deploy'], required_evidence: ['worker_lease'], eval_threshold: 0.75,
      removal_strategy: 'disable',
      metadata: { agent_skill_id: 'unknown-tokens-skill', agent_skill_version: '0.1.0', agent_skill_content_hash: 'candidate-hash' },
    });
    // same success share and duration as the baseline; only the (unreported) token count could look like an improvement
    const evidence = seedSkillEvidence('unknown-tokens-skill', 'candidate-hash', 'baseline-hash', 24, null, 1_000);

    expect(() => svc.promoteCapability('unknown-tokens-skill', { eval_score: 0.9, ...evidence }))
      .toThrow('CAPABILITY_PROMOTION_SKILL_NO_MEASURABLE_IMPROVEMENT');
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
