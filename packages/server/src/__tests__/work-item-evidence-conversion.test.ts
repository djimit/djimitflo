import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { BOARD_HANDOFF_AUTHORITY, WorkItemService } from '../services/work-item-service';

describe('WorkItemService evidence conversion', () => {
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
