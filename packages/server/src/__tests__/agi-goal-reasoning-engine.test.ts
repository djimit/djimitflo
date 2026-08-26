import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { AgiGoalReasoningEngine } from '../services/agi-goal-reasoning-engine';

describe('AgiGoalReasoningEngine', () => {
  const db = new Database(':memory:');
  afterEach(() => db.exec('DELETE FROM strategy_nodes; DELETE FROM goal_hypotheses'));

  it('builds strategy nodes from schema-validated LLM router output', async () => {
    const generateStructured = vi.fn().mockResolvedValue('{"steps":["Inspect state","Apply fix","Verify outcome"]}');
    const engine = new AgiGoalReasoningEngine(db, { generateStructured } as any);
    const [goal] = engine.deduceGoals({ observations: ['failing gate'], anomalies: [], opportunities: ['Fix failing gate'] });

    const nodes = await engine.planStrategy(goal.id);

    expect(generateStructured).toHaveBeenCalledOnce();
    expect(nodes.map((node) => node.action)).toEqual(['Inspect state', 'Apply fix', 'Verify outcome']);
    expect(nodes[1].preconditions).toEqual([nodes[0].id]);
  });
});
