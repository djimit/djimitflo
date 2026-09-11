import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { BOARD_HANDOFF_AUTHORITY, WorkItemService, securityFindingFingerprint } from '../services/work-item-service';
import express from 'express';
import request from 'supertest';
import { createWorkItemRoutes } from '../routes/work-items';
import { errorHandler } from '../middleware/error-handler';

describe('WorkItemService evidence conversion', () => {
  it('reuses an existing goal without rewinding leased work or replacing its lineage', () => {
    const db = createTestDb();
    try {
      const service = new WorkItemService(db);
      const item = service.create({ title: 'One work item', description: 'No execution' });
      const first = service.convertToGoal(item.id);
      expect(service.convertToGoal(item.id).goal_id).toBe(first.goal_id);
      service.update(item.id, { status: 'leased', metadata: { loop_run_id: 'existing-loop' } });
      expect(service.convertToGoal(item.id)).toMatchObject({ goal_id: first.goal_id, work_item: { status: 'leased', metadata: { loop_run_id: 'existing-loop' } } });
      expect(db.prepare('SELECT COUNT(*) AS count FROM goals').get()).toEqual({ count: 1 });
    } finally { db.close(); }
  });

  it.each(['blocked', 'planned', 'leased', 'done', 'discarded'] as const)('does not create goals for %s work with no admitted conversion', (status) => {
    const db = createTestDb();
    try {
      const service = new WorkItemService(db);
      const item = service.create({ title: 'Ineligible work', description: 'No execution', status });
      expect(() => service.convertToGoal(item.id)).toThrow('WORK_ITEM_CONVERSION_INVALID_STATE');
      expect(db.prepare('SELECT COUNT(*) AS count FROM goals').get()).toEqual({ count: 0 });
      expect(service.get(item.id)).toMatchObject({ status, parent_goal_id: null });
    } finally { db.close(); }
  });

  it('rolls back the new goal if linking the work item fails', () => {
    const db = createTestDb();
    try {
      const service = new WorkItemService(db);
      const item = service.create({ title: 'Atomic conversion', description: 'No execution' });
      db.exec("CREATE TRIGGER reject_conversion BEFORE UPDATE ON work_items BEGIN SELECT RAISE(ABORT, 'fixture_link_failure'); END");
      expect(() => service.convertToGoal(item.id)).toThrow('fixture_link_failure');
      expect(db.prepare('SELECT COUNT(*) AS count FROM goals').get()).toEqual({ count: 0 });
      expect(service.get(item.id)).toMatchObject({ status: 'candidate', parent_goal_id: null });
    } finally { db.close(); }
  });

  it('does not leave an orphan goal when terminal security reopening is rejected', () => {
    const db = createTestDb();
    try {
      const service = new WorkItemService(db);
      const security = {
        target: 'fixture', source_identity: 'fixture-1', tool: 'synthetic', rule_id: 'R1', location: 'file:1',
        severity: 'low' as const, cia_impact: ['integrity' as const], threat: 'Synthetic test finding',
        attack_path: ['fixture'], evidence_refs: ['fixture:1'],
        disposition: { type: 'false_positive', reason: 'Fixture only', evidence_refs: ['fixture:review'] },
      };
      const fingerprint = securityFindingFingerprint(security);
      const item = service.create({ title: 'Disposed finding', description: 'No execution', source: 'security_finding', source_ref: fingerprint, risk_class: 'low', recommended_loop: 'security-regression-loop', status: 'discarded', metadata: { security: { ...security, fingerprint } } });
      expect(() => service.convertToGoal(item.id)).toThrow('SECURITY_FINDING_REOPEN_IMPORT_REQUIRED');
      expect(db.prepare('SELECT COUNT(*) AS count FROM goals').get()).toEqual({ count: 0 });
      expect(service.get(item.id)).toMatchObject({ status: 'discarded', parent_goal_id: null });
    } finally { db.close(); }
  });

  it('returns a conflict over HTTP without writes for a discarded work item', async () => {
    const db = createTestDb();
    try {
      const item = new WorkItemService(db).create({ title: 'Discarded', description: 'No execution', status: 'discarded' });
      const app = express();
      app.use('/work-items', createWorkItemRoutes(db));
      app.use(errorHandler);
      const response = await request(app).post(`/work-items/${item.id}/convert-to-goal`);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('WORK_ITEM_CONVERSION_INVALID_STATE');
      expect(db.prepare('SELECT COUNT(*) AS count FROM goals').get()).toEqual({ count: 0 });
    } finally { db.close(); }
  });

  it('keeps one persisted goal across repeated HTTP conversion and reload', async () => {
    const db = createTestDb();
    try {
      const item = new WorkItemService(db).create({ title: 'Repeat HTTP', description: 'No execution' });
      const app = express();
      app.use('/work-items', createWorkItemRoutes(db));
      app.use(errorHandler);
      const first = await request(app).post(`/work-items/${item.id}/convert-to-goal`);
      const second = await request(app).post(`/work-items/${item.id}/convert-to-goal`);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201); // Existing response contract retained for idempotent replay.
      expect(second.body.goal_id).toBe(first.body.goal_id);
      const reloaded = await request(app).get(`/work-items/${item.id}`);
      expect(reloaded.body).toMatchObject({ status: 'planned', parent_goal_id: first.body.goal_id });
      expect(db.prepare('SELECT COUNT(*) AS count FROM goals').get()).toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM worker_leases').get()).toEqual({ count: 0 });
    } finally { db.close(); }
  });

  it('rolls back the goal on HTTP linking failure and permits a clean retry', async () => {
    const db = createTestDb();
    try {
      const item = new WorkItemService(db).create({ title: 'HTTP rollback', description: 'No execution' });
      const app = express();
      app.use('/work-items', createWorkItemRoutes(db));
      app.use(errorHandler);
      db.exec("CREATE TRIGGER reject_conversion BEFORE UPDATE ON work_items BEGIN SELECT RAISE(ABORT, 'fixture_link_failure'); END");
      const failed = await request(app).post(`/work-items/${item.id}/convert-to-goal`);
      expect(failed.status).toBe(500);
      expect(db.prepare('SELECT COUNT(*) AS count FROM goals').get()).toEqual({ count: 0 });
      expect((await request(app).get(`/work-items/${item.id}`)).body).toMatchObject({ status: 'candidate', parent_goal_id: null });
      db.exec('DROP TRIGGER reject_conversion');
      const retry = await request(app).post(`/work-items/${item.id}/convert-to-goal`);
      expect(retry.status).toBe(201);
      expect(db.prepare('SELECT COUNT(*) AS count FROM goals').get()).toEqual({ count: 1 });
    } finally { db.close(); }
  });

  it('keeps board-origin work behind the review gate at creation', () => {
    const db = createTestDb();
    const service = new WorkItemService(db);
    expect(() => service.create({
      title: 'Forged board action', description: 'Must remain gated', source: 'agent_board', status: 'done',
    })).toThrow('BOARD_HANDOFF_REVIEW_REQUIRED');
    expect(() => service.createIfMissingBySourceRef({
      title: 'Forged board action', description: 'Must remain gated', source: 'agent_board', source_ref: 'forged:1', status: 'blocked',
    })).toThrow('BOARD_HANDOFF_REVIEW_REQUIRED');
    expect(() => service.create({
      title: 'Whitespace board action', description: 'Must remain gated', source: ' agent_board ', status: 'done',
    })).toThrow('BOARD_HANDOFF_REVIEW_REQUIRED');
    expect(() => service.createIfMissingBySourceRef({
      title: 'Malformed internal action', description: 'Must remain gated', source: 'agent_board', source_ref: 'forged:2', status: 'done',
    }, BOARD_HANDOFF_AUTHORITY)).toThrow('BOARD_HANDOFF_REVIEW_REQUIRED');
    db.close();
  });

  it('preserves evidence, constraints, acceptance and falsification in the goal', () => {
    const db = createTestDb();
    const service = new WorkItemService(db);
    const item = service.create({
      title: 'Fallback title',
      description: 'Fallback acceptance',
      source: 'worldlab_outcome',
      source_ref: 'worldlab:experiment-1',
      risk_class: 'medium',
      recommended_loop: 'maker-checker-approver',
      metadata: {
        objective: 'Contain replicated propagation',
        constraints: ['preserve ToolBroker'],
        acceptance_criteria: ['targeted retest passes'],
        falsification_tests: ['effect lower bound is not positive'],
        evidence_hash: 'sha256:evidence',
      },
    });

    const converted = service.convertToGoal(item.id);
    const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(converted.goal_id) as any;
    expect(goal.objective).toBe('Contain replicated propagation');
    expect(JSON.parse(goal.constraints_json)).toEqual(['preserve ToolBroker']);
    expect(JSON.parse(goal.acceptance_criteria_json)).toEqual(['targeted retest passes']);
    expect(JSON.parse(goal.metadata)).toMatchObject({
      source: 'worldlab_outcome',
      source_ref: 'worldlab:experiment-1',
      evidence_hash: 'sha256:evidence',
      falsification_tests: ['effect lower bound is not positive'],
    });
    db.close();
  });

  it('normalizes source identity for upsert deduplication', () => {
    const db = createTestDb();
    const service = new WorkItemService(db);
    const first = service.upsertBySourceRef({
      title: 'Identity', description: 'One source', source: ' external ', source_ref: 'source:1',
    });
    const second = service.upsertBySourceRef({
      title: 'Identity update', description: 'Same source', source: 'external', source_ref: 'source:1',
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.work_item.id).toBe(first.work_item.id);
    db.close();
  });
});
