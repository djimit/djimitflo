import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './helpers/test-db';
import { GoalBatchService } from '../services/goal-batch-service';
import { WorldLabEvidenceService } from '../services/worldlab-evidence-service';
import { AgentInteractionLedgerService } from '../services/agent-interaction-ledger-service';

let db: Database.Database;

beforeEach(() => { db = createTestDb(); });
afterEach(() => db.close());

function createGoal(findingId = 'finding-1') {
  const goal = new GoalBatchService(db).apply({ batch: {
    change: 'worldlab-campaign-1', goals: [{ id: 'goal-1', title: 'Confirm finding', risk: 'medium',
      acceptance: ['all gates pass'], target: 'worldlab' }],
  } }).created_goals[0];
  db.prepare('UPDATE goals SET metadata = ? WHERE id = ?').run(JSON.stringify({
    ...goal.metadata,
    openmythos_source: { finding_id: findingId, evidence_hash: `sha256:${'a'.repeat(64)}` },
  }), goal.id);
  return { ...goal, metadata: { ...goal.metadata, openmythos_source: { finding_id: findingId } } };
}

function retest(goalId: string, overrides: Record<string, unknown> = {}, gates: Record<string, string> = {
  static_openmythos: 'PASS', worldlab_targeted: 'PASS', djimitflo_tests: 'PASS', security_invariants: 'PASS',
}) {
  return {
    schema: 'djimit.openmythos.worldlab.retest.v1', finding_id: 'finding-1', goal_id: goalId,
    change_id: 'change-1', commit: 'abcdef1234567', trajectory_id: 'trajectory-retest-1',
    evidence_hash: `sha256:${'b'.repeat(64)}`, gates,
    evidence_refs: ['openmythos:static-1', 'worldlab:retest-1', 'djimitflo:proof-1', 'security:invariants-1'],
    ...overrides,
  };
}

describe('WorldLabEvidenceService', () => {
  it('links finding, change, commit, retest and goal without promoting', () => {
    const goal = createGoal();
    const service = new WorldLabEvidenceService(db);
    expect(service.recordRetest(retest(goal.id))).toMatchObject({ decision: 'PROMOTION_CANDIDATE', duplicate: false, promoted: false });
    expect(service.recordRetest(retest(goal.id))).toMatchObject({ decision: 'PROMOTION_CANDIDATE', duplicate: true, promoted: false });
    const stored = db.prepare('SELECT status, metadata FROM goals WHERE id = ?').get(goal.id) as any;
    expect(stored.status).toBe('created');
    expect(JSON.parse(stored.metadata)).toMatchObject({ promotion_state: 'PROMOTION_CANDIDATE', worldlab_retests: [{ promoted: false }] });
    expect(new AgentInteractionLedgerService(db).list({ source: 'swarm_evidence_edges' }).length).toBeGreaterThanOrEqual(7);
  });

  it('rejects when any gate is FAIL', () => {
    const goal = createGoal();
    const service = new WorldLabEvidenceService(db);
    const result = service.recordRetest(retest(goal.id, {}, {
      static_openmythos: 'PASS', worldlab_targeted: 'FAIL', djimitflo_tests: 'PASS', security_invariants: 'PASS',
    }));
    expect(result.decision).toBe('REJECTED');
    expect(result.promoted).toBe(false);
    const stored = db.prepare('SELECT metadata FROM goals WHERE id = ?').get(goal.id) as any;
    expect(JSON.parse(stored.metadata).promotion_state).toBe('REJECTED');
  });

  it('prioritises FAIL over UNDETERMINED (REJECTED wins)', () => {
    const goal = createGoal();
    const service = new WorldLabEvidenceService(db);
    const result = service.recordRetest(retest(goal.id, {}, {
      static_openmythos: 'UNDETERMINED', worldlab_targeted: 'FAIL', djimitflo_tests: 'PASS', security_invariants: 'PASS',
    }));
    expect(result.decision).toBe('REJECTED');
  });

  it('throws WORLDLAB_RETEST_GOAL_NOT_FOUND for an unknown goal', () => {
    const service = new WorldLabEvidenceService(db);
    expect(() => service.recordRetest(retest('nonexistent-goal'))).toThrow('WORLDLAB_RETEST_GOAL_NOT_FOUND');
  });

  it('throws WORLDLAB_RETEST_FINDING_MISMATCH when finding_id does not match the goal source', () => {
    const goal = createGoal('finding-original');
    const service = new WorldLabEvidenceService(db);
    expect(() => service.recordRetest(retest(goal.id, { finding_id: 'finding-different' })))
      .toThrow('WORLDLAB_RETEST_FINDING_MISMATCH');
  });

  it('rejects a payload with the wrong schema literal', () => {
    const goal = createGoal();
    const service = new WorldLabEvidenceService(db);
    expect(() => service.recordRetest(retest(goal.id, { schema: 'djimit.openmythos.worldlab.retest.v2' })))
      .toThrow('WORLDLAB_RETEST_INVALID');
  });

  it.each([
    ['finding_id', ''],
    ['goal_id', ''],
    ['change_id', ''],
    ['trajectory_id', ''],
  ])('rejects empty %s', (field, value) => {
    const goal = createGoal();
    const service = new WorldLabEvidenceService(db);
    expect(() => service.recordRetest(retest(goal.id, { [field]: value })))
      .toThrow('WORLDLAB_RETEST_INVALID');
  });

  it('rejects a commit that does not match /^[a-f0-9]{7,64}$/', () => {
    const goal = createGoal();
    const service = new WorldLabEvidenceService(db);
    // too short (6 chars)
    expect(() => service.recordRetest(retest(goal.id, { commit: 'abc123' }))).toThrow('WORLDLAB_RETEST_INVALID');
    // uppercase hex is rejected
    expect(() => service.recordRetest(retest(goal.id, { commit: 'ABCDEF1234567' }))).toThrow('WORLDLAB_RETEST_INVALID');
    // non-hex character
    expect(() => service.recordRetest(retest(goal.id, { commit: 'abcdefg' }))).toThrow('WORLDLAB_RETEST_INVALID');
  });

  it('rejects an evidence_hash that is not sha256:<64 lowercase hex>', () => {
    const goal = createGoal();
    const service = new WorldLabEvidenceService(db);
    // wrong prefix
    expect(() => service.recordRetest(retest(goal.id, { evidence_hash: `md5:${'b'.repeat(64)}` })))
      .toThrow('WORLDLAB_RETEST_INVALID');
    // hash one char too short
    expect(() => service.recordRetest(retest(goal.id, { evidence_hash: `sha256:${'b'.repeat(63)}` })))
      .toThrow('WORLDLAB_RETEST_INVALID');
  });

  it('rejects fewer than 4 evidence_refs', () => {
    const goal = createGoal();
    const service = new WorldLabEvidenceService(db);
    expect(() => service.recordRetest(retest(goal.id, {
      evidence_refs: ['openmythos:a', 'worldlab:b', 'djimitflo:c'],
    }))).toThrow('WORLDLAB_RETEST_INVALID');
  });

  it.each([
    ['openmythos:', ['worldlab:r1', 'djimitflo:p1', 'security:s1', 'extra:e1']],
    ['worldlab:', ['openmythos:s1', 'djimitflo:p1', 'security:s1', 'extra:e1']],
    ['djimitflo:', ['openmythos:s1', 'worldlab:r1', 'security:s1', 'extra:e1']],
    ['security:', ['openmythos:s1', 'worldlab:r1', 'djimitflo:p1', 'extra:e1']],
  ])('rejects when no evidence_ref starts with %s', (_prefix, refs) => {
    const goal = createGoal();
    const service = new WorldLabEvidenceService(db);
    expect(() => service.recordRetest(retest(goal.id, { evidence_refs: refs as string[] })))
      .toThrow('WORLDLAB_RETEST_INVALID');
  });

  it('rejects extra top-level fields (strict schema)', () => {
    const goal = createGoal();
    const service = new WorldLabEvidenceService(db);
    expect(() => service.recordRetest({ ...retest(goal.id), unexpected_field: true }))
      .toThrow('WORLDLAB_RETEST_INVALID');
  });

  it('rejects extra gate keys (strict gates object)', () => {
    const goal = createGoal();
    const service = new WorldLabEvidenceService(db);
    expect(() => service.recordRetest(retest(goal.id, {}, {
      static_openmythos: 'PASS', worldlab_targeted: 'PASS', djimitflo_tests: 'PASS', security_invariants: 'PASS', extra_gate: 'PASS',
    }))).toThrow('WORLDLAB_RETEST_INVALID');
  });

  it('never treats unknown or incomplete evidence as pass', () => {
    const goal = createGoal();
    const service = new WorldLabEvidenceService(db);
    expect(service.recordRetest(retest(goal.id, {}, {
      static_openmythos: 'PASS', worldlab_targeted: 'UNDETERMINED', djimitflo_tests: 'PASS', security_invariants: 'PASS',
    }))).toMatchObject({ decision: 'UNDETERMINED', promoted: false });
    expect(() => service.recordRetest({ ...retest(goal.id), evidence_refs: ['worldlab:only'] }))
      .toThrow('WORLDLAB_RETEST_INVALID');
  });

  it('detects duplicates by stable id (same payload yields same id)', () => {
    const goal = createGoal();
    const service = new WorldLabEvidenceService(db);
    const first = service.recordRetest(retest(goal.id));
    const second = service.recordRetest(retest(goal.id));
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
  });

  it('creates exactly the expected number of evidence edges for a fresh retest', () => {
    const goal = createGoal();
    const service = new WorldLabEvidenceService(db);
    service.recordRetest(retest(goal.id));
    // 8 fixed structural edges + 4 "supports" edges (one per unique evidence_ref) = 12
    const rows = db.prepare('SELECT * FROM swarm_evidence_edges').all() as any[];
    expect(rows.length).toBe(12);
  });

  it('does not duplicate evidence edges on a repeated retest', () => {
    const goal = createGoal();
    const service = new WorldLabEvidenceService(db);
    service.recordRetest(retest(goal.id));
    const countAfterFirst = (db.prepare('SELECT COUNT(*) AS c FROM swarm_evidence_edges').get() as any).c;
    service.recordRetest(retest(goal.id));
    const countAfterSecond = (db.prepare('SELECT COUNT(*) AS c FROM swarm_evidence_edges').get() as any).c;
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it('handles array metadata gracefully (object() returns empty object)', () => {
    const goal = createGoal();
    db.prepare('UPDATE goals SET metadata = ? WHERE id = ?').run('[1,2,3]', goal.id);
    const service = new WorldLabEvidenceService(db);
    // metadata parses to an array → object() returns {} → no openmythos_source → finding mismatch
    expect(() => service.recordRetest(retest(goal.id))).toThrow('WORLDLAB_RETEST_FINDING_MISMATCH');
  });

  it('handles invalid JSON metadata gracefully (object() catches parse error)', () => {
    const goal = createGoal();
    db.prepare('UPDATE goals SET metadata = ? WHERE id = ?').run('{invalid json', goal.id);
    const service = new WorldLabEvidenceService(db);
    expect(() => service.recordRetest(retest(goal.id))).toThrow('WORLDLAB_RETEST_FINDING_MISMATCH');
  });

  it('stores recorded_at timestamp and promoted=false on the retest record', () => {
    const goal = createGoal();
    const service = new WorldLabEvidenceService(db);
    const before = new Date().toISOString();
    const result = service.recordRetest(retest(goal.id));
    const stored = db.prepare('SELECT metadata FROM goals WHERE id = ?').get(goal.id) as any;
    const retests = JSON.parse(stored.metadata).worldlab_retests;
    expect(retests).toHaveLength(1);
    expect(retests[0].id).toBe(result.id);
    expect(retests[0].promoted).toBe(false);
    expect(typeof retests[0].recorded_at).toBe('string');
    expect(retests[0].recorded_at >= before).toBe(true);
  });
});
