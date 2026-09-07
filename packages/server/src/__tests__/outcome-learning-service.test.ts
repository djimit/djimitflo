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
    })]);
    expect((db.prepare("SELECT COUNT(*) count FROM work_items WHERE source = 'outcome_observed'").get() as any).count).toBe(1);
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
    service.releaseContainment('capability-1', {
      released_by: 'operator', evidence_refs: ['worldlab:retest', 'openmythos:static-regression', 'approval:paperclip-1'],
    });
    expect(new SwarmIntelligenceService(db).getCapability('capability-1').blocked_reasons).not.toContain('outcome_evidence_hold');
  });
});
