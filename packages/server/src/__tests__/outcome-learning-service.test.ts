import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { OutcomeLearningService } from '../services/outcome-learning-service';
import { createTestDb } from './helpers/test-db';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';

let db: Database.Database;

beforeEach(() => { db = createTestDb(); });
afterEach(() => db.close());

function insertOutcome(index: number, overrides: Record<string, unknown> = {}) {
  const payload = {
    outcome_id: `outcome-${index}`,
    candidate_id: 'candidate-1',
    capability_id: 'capability-1',
    task_id: 'task-1',
    model_id: 'model-1',
    skill_id: 'skill-1',
    skill_version: '1.0.0',
    skill_hash: 'sha256:skill-1',
    runtime_identity: 'git:test',
    cost_amount: 0.1,
    cost_currency: 'EUR',
    cost_basis: 'test_fixture',
    metric: 'qualified_result_rate',
    value: 0.8 + index * 0.01,
    baseline: 0.5,
    direction: 'increase',
    minimum_effect: 0.1,
    observation_window: 'P30D',
    evidence_refs: [`evidence:${index}`],
    confidence: 0.9,
    causal_status: 'randomized',
    replication_id: `seed-${index}`,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO external_events (id, event_type, source, occurred_at, payload)
    VALUES (?, 'outcome.observed', 'test', ?, ?)
  `).run(`event-${index}-${String(overrides.candidate_id || 'candidate-1')}`, new Date(2026, 0, index + 1).toISOString(), JSON.stringify(payload));
}

describe('OutcomeLearningService', () => {
  it('creates one idempotent work item from replicated causal evidence', () => {
    insertOutcome(0);
    insertOutcome(1);
    insertOutcome(2);
    const service = new OutcomeLearningService(db, { minimumReplications: 3 });

    expect(service.process()).toMatchObject({ assessments: 1, work_items_created: 1, supported: 1 });
    expect(service.process()).toMatchObject({ assessments: 1, work_items_created: 0, supported: 1 });
    expect(service.list()).toEqual([expect.objectContaining({
      status: 'SUPPORTED', signal_status: 'SUPPORTED', replications: 3, causal_support: true,
      result: expect.objectContaining({
        skill_attribution: { skill_id: 'skill-1', skill_version: '1.0.0', skill_hash: 'sha256:skill-1', complete: true },
        execution_attribution: expect.objectContaining({ task_ids: ['task-1'], model_ids: ['model-1'], total_cost: 0.30000000000000004 }),
      }),
    })]);
    expect((db.prepare("SELECT COUNT(*) count FROM work_items WHERE source = 'outcome_observed'").get() as any).count).toBe(1);
  });

  it('aggregates varying per-replication baselines into one experiment series', () => {
    insertOutcome(0, { baseline: 0.48 });
    insertOutcome(1, { baseline: 0.50 });
    insertOutcome(2, { baseline: 0.52 });
    const service = new OutcomeLearningService(db, { minimumReplications: 3 });

    expect(service.process()).toMatchObject({ groups: 1, assessments: 1, supported: 1 });
    expect(service.list()[0]).toMatchObject({ replications: 3, baseline_value: 0.5 });
  });

  it('keeps a replicated correlated signal undetermined and promotion-ineligible', () => {
    for (let index = 0; index < 3; index += 1) insertOutcome(index, { causal_status: 'correlated' });
    const service = new OutcomeLearningService(db, { minimumReplications: 3 });
    expect(service.process()).toMatchObject({ work_items_created: 1, undetermined: 1 });
    const assessment = service.list()[0];
    expect(assessment).toMatchObject({ status: 'UNDETERMINED', signal_status: 'SUPPORTED', causal_support: false });
    expect(assessment.result).toMatchObject({ promotion_eligible: false, required_next_gate: 'controlled_or_counterfactual_evidence' });
  });

  it('does not create work from incomplete or duplicate replication evidence', () => {
    insertOutcome(0, { direction: undefined, replication_id: 'same-seed' });
    insertOutcome(1, { direction: undefined, replication_id: 'same-seed' });
    const service = new OutcomeLearningService(db, { minimumReplications: 3 });
    expect(service.process()).toMatchObject({ assessments: 1, work_items_created: 0, undetermined: 1 });
    expect(service.list()[0].replications).toBe(1);
  });

  it('falsifies an asserted increase when the interval stays below the threshold', () => {
    for (let index = 0; index < 3; index += 1) insertOutcome(index, { value: 0.4 + index * 0.01 });
    const service = new OutcomeLearningService(db, { minimumReplications: 3 });
    expect(service.process()).toMatchObject({ work_items_created: 1, falsified: 1 });
    expect(service.list()[0].status).toBe('FALSIFIED');
  });

  it('contains a repeatedly falsified capability and requires independent release evidence', () => {
    db.prepare(`INSERT INTO swarm_capabilities (
      id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref,
      allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score,
      eval_threshold, cost_model_json, removal_strategy, metadata, created_at, updated_at
    ) VALUES ('capability-1', 'skill', 'test', '1', 'validated', 'low', 'in', 'out',
      '["read"]', '["deploy"]', '["proof"]', 1, 0.5, '{}', 'hold_on_regression', '{}', datetime('now'), datetime('now'))`).run();
    for (let index = 0; index < 3; index += 1) insertOutcome(index, { value: 0.4 + index * 0.01 });
    const service = new OutcomeLearningService(db, { minimumReplications: 3, containmentMinReplications: 3 });
    service.process();
    expect(new SwarmIntelligenceService(db).getCapability('capability-1').blocked_reasons).toContain('outcome_evidence_hold');
    expect(() => service.releaseContainment('capability-1', { released_by: 'operator', evidence_refs: ['worldlab:retest'] }))
      .toThrow('OUTCOME_CONTAINMENT_RELEASE_EVIDENCE_REQUIRED');
    expect(() => service.releaseContainment('capability-1', {
      released_by: 'operator', evidence_refs: ['worldlab:retest', 'openmythos:static-regression', 'approval:paperclip-1'],
    })).toThrow('OUTCOME_CONTAINMENT_RELEASE_EVIDENCE_UNRESOLVED');
    db.prepare(`INSERT INTO openmythos_eval_runs (id, agent_id, total_cases, completed_cases, status, metadata)
      VALUES ('om-run', 'agent', 1, 1, 'completed', '{}')`).run();
    db.prepare(`INSERT INTO openmythos_attestations
      (id, run_id, schema_version, corpus_sha256, openmythos_commit, certification_eligible, corpus_certification_ready, payload, imported_by)
      VALUES ('attestation-1', 'om-run', 'v1', 'corpus', 'abcdef1', 1, 1, '{}', 'checker')`).run();
    db.prepare(`INSERT INTO goals (id, objective, constraints_json, acceptance_criteria_json, risk_class, budget_json, status, metadata)
      VALUES ('goal-retest', 'Retest', '[]', '["passes"]', 'medium', '{}', 'created', ?)`).run(JSON.stringify({
        worldlab_retests: [{ id: 'worldlab-retest:1', decision: 'PROMOTION_CANDIDATE' }],
      }));
    db.prepare(`INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode)
      VALUES ('release-task', 'Release containment', 'Independent release', 'completed', 'high', 'high', 'review_only')`).run();
    db.prepare(`INSERT INTO approvals
      (id, task_id, status, risk_level, request_type, request_message, request_data, requested_by, decided_by, metadata)
      VALUES ('release-approval', 'release-task', 'approved', 'high', 'high_risk_action', 'Release', '{}', 'maker', 'approver', ?)`).run(JSON.stringify({
        capability_id: 'capability-1', action: 'release_outcome_containment',
      }));
    service.releaseContainment('capability-1', {
      released_by: 'approver', evidence_refs: ['worldlab:worldlab-retest:1', 'openmythos:attestation-1', 'approval:release-approval'],
    });
    expect(new SwarmIntelligenceService(db).getCapability('capability-1').blocked_reasons).not.toContain('outcome_evidence_hold');
  });
});
