import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/test-db';
import type { Database } from 'better-sqlite3';
import { GovernanceFeedbackLoopExperiment } from '../services/governance-experiment-service';

describe('GovernanceFeedbackLoopExperiment', () => {
  let db: Database;
  let experiment: GovernanceFeedbackLoopExperiment;

  beforeEach(() => {
    db = createTestDb() as unknown as Database;
    experiment = new GovernanceFeedbackLoopExperiment(db);
  });

  afterEach(() => {
    db.close();
  });

  it('runs a full experiment', () => {
    const result = experiment.run({
      group_a_size: 5,
      group_b_size: 5,
      iterations: 3,
      seed: 42,
    });

    expect(result.experiment_id).toBeDefined();
    expect(result.group_a_avg_delta).toBeGreaterThan(0);
    expect(result.group_b_avg_delta).toBeGreaterThan(0);
  });

  it('persists results to database', () => {
    experiment.run({
      group_a_size: 2,
      group_b_size: 2,
      iterations: 2,
      seed: 42,
    });

    const row = db.prepare('SELECT COUNT(*) as c FROM experiment_results').get() as any;
    expect(row.c).toBe(8); // 2 groups x 2 subjects x 2 iterations
  });

  it('group A outperforms group B on average', () => {
    const result = experiment.run({
      group_a_size: 10,
      group_b_size: 10,
      iterations: 5,
      seed: 42,
    });

    // Group A (auto-fix) should have higher average delta than Group B (manual)
    expect(result.improvement).toBeGreaterThan(0);
  });

  it('returns all results', () => {
    experiment.run({
      group_a_size: 2,
      group_b_size: 2,
      iterations: 2,
      seed: 42,
    });

    const results = experiment.getResults();
    expect(results).toHaveLength(8);
  });

  it('calculates significance', () => {
    const result = experiment.run({
      group_a_size: 20,
      group_b_size: 20,
      iterations: 10,
      seed: 42,
    });

    expect(result.p_value).toBeGreaterThan(0);
    expect(result.p_value).toBeLessThan(1);
  });
});
