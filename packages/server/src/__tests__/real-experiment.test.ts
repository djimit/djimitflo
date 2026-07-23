import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/test-db';
import type { Database } from 'better-sqlite3';
import { RealExperimentRunner } from '../services/real-experiment-runner';
import { DjimFloGovernanceEvaluator } from '../services/governance-evaluator';
import { ExperimentTrackingService } from '../services/experiment-tracking-service';

describe('Real Experiment Execution', () => {
  let db: Database;
  let runner: RealExperimentRunner;
  let evaluator: DjimFloGovernanceEvaluator;
  let tracking: ExperimentTrackingService;

  beforeEach(() => {
    db = createTestDb() as unknown as Database;
    runner = new RealExperimentRunner(db);
    evaluator = new DjimFloGovernanceEvaluator(db);
    tracking = new ExperimentTrackingService(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('Governance Baseline Evaluation', () => {
    it('establishes a baseline score', async () => {
      const baseline = await evaluator.runBaseline();

      expect(baseline.baseline_id).toBeDefined();
      expect(baseline.overall_score).toBeGreaterThan(0);
      expect(baseline.overall_score).toBeLessThanOrEqual(5);
      expect(baseline.category_scores).toHaveLength(11);
      expect(baseline.gaps.length).toBeGreaterThan(0);
    });

    it('identifies critical gaps', async () => {
      const baseline = await evaluator.runBaseline();

      const criticalGaps = baseline.gaps.filter(g => g.severity === 'critical');
      const highGaps = baseline.gaps.filter(g => g.severity === 'high');

      // Temporal, cross_lingual, and canary should be critical
      expect(criticalGaps.length).toBeGreaterThan(0);
      expect(highGaps.length).toBeGreaterThan(0);
    });

    it('provides actionable recommendations', async () => {
      const baseline = await evaluator.runBaseline();

      expect(baseline.recommendations.length).toBeGreaterThan(0);
      expect(baseline.recommendations.some(r => r.includes('critical'))).toBe(true);
    });
  });

  describe('Feedback Loop Experiment', () => {
    it('runs a complete experiment with auto-fix', async () => {
      const run = await runner.runExperiment({
        name: 'governance-feedback-loop-test',
        description: 'Test of governance-driven self-improvement',
        iterations: 5,
        cases_per_iteration: 10,
        auto_fix: true,
      });

      expect(run.run_id).toBeDefined();
      expect(run.baseline_score).toBeGreaterThan(0);
      expect(run.iterations).toHaveLength(5);
      expect(run.statistics).toBeDefined();
    });

    it('tracks metrics per iteration', async () => {
      const run = await runner.runExperiment({
        name: 'metric-tracking-test',
        description: 'Verify per-iteration metrics',
        iterations: 3,
        cases_per_iteration: 5,
        auto_fix: true,
      });

      for (const iteration of run.iterations) {
        expect(iteration.iteration).toBeGreaterThan(0);
        expect(iteration.score_before).toBeGreaterThan(0);
        expect(iteration.score_after).toBeGreaterThan(0);
        expect(iteration.duration_ms).toBeGreaterThanOrEqual(0);
      }
    });

    it('performs statistical analysis', async () => {
      const run = await runner.runExperiment({
        name: 'statistical-analysis-test',
        description: 'Verify statistical analysis',
        iterations: 10,
        cases_per_iteration: 10,
        auto_fix: true,
      });

      expect(run.statistics.mean_delta).toBeDefined();
      expect(run.statistics.p_value).toBeGreaterThanOrEqual(0);
      expect(run.statistics.p_value).toBeLessThanOrEqual(1);
      expect(run.statistics.confidence_interval_95).toHaveLength(2);
    });
  });

  describe('Experiment Tracking', () => {
    it('starts and ends a run', () => {
      const runId = tracking.startRun('test-experiment', { param1: 'value1' });
      expect(runId).toBeDefined();

      tracking.logMetric(runId, 'score', 4.5, 0);
      tracking.logMetric(runId, 'score', 4.8, 1);
      tracking.endRun(runId);

      const run = tracking.getRun(runId);
      expect(run).not.toBeNull();
      expect(run!.status).toBe('completed');
      expect(run!.metrics['score']).toBe(4.8);
    });

    it('compares two runs', () => {
      const runA = tracking.startRun('experiment-a', {});
      tracking.logMetric(runA, 'score', 4.0, 0);
      tracking.endRun(runA);

      const runB = tracking.startRun('experiment-b', {});
      tracking.logMetric(runB, 'score', 4.5, 0);
      tracking.endRun(runB);

      const comparison = tracking.compareRuns(runA, runB);
      expect(comparison.metrics_diff['score']).toBe(-0.5);
    });

    it('lists runs by experiment', () => {
      tracking.startRun('exp-1', {});
      tracking.startRun('exp-1', {});
      tracking.startRun('exp-2', {});

      const runs = tracking.listRuns('exp-1');
      expect(runs).toHaveLength(2);
    });
  });
});
