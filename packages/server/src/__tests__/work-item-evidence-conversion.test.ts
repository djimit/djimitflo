import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { WorkItemService } from '../services/work-item-service';

describe('WorkItemService evidence conversion', () => {
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
});
