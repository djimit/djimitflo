// Run with: npx tsx reports/autonomous-audit-20260909/evidence/cognitive-evidence-probe.mjs
// Immutable synthetic outcomes, actual in-memory SQLite/service; no provider/filesystem effects.
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { CognitiveLoopClosureService } from '../../../packages/server/src/services/cognitive-loop-closure-service.ts';

const db = new Database(':memory:');
try {
  const service = new CognitiveLoopClosureService(db);
  const outcomes = Object.freeze(['failure', 'failure', 'failure', 'failure', 'failure', 'success', 'success', 'success', 'success', 'success']);
  for (const [i, outcome] of outcomes.entries()) service.recordEpisode({
    loopRunId: `immutable-fixture-${i}`, goalId: 'fixture', goalType: 'fixture', mode: 'closed',
    startedAt: '2026-09-09T00:00:00Z', completedAt: '2026-09-09T00:00:01Z', durationMs: 1000,
    outcome, strategy: 'candidate', actions: [], metadata: { synthetic: true },
    metrics: { totalLeases: 0, completedLeases: 0, failedLeases: 0, totalTokens: 0, totalCostDollars: 0, diffLinesChanged: 0, filesModified: 0, gatesPassed: 0, gatesFailed: 0 },
  });
  const baseline = service.getBestStrategy('fixture');
  for (let i = 0; i < 9; i++) service.evolveStrategies();
  const candidate = service.getBestStrategy('fixture');
  const oracle = 0.5;
  assert.equal(baseline.successRate, oracle);
  assert.equal(candidate.successRate, oracle);
  assert.equal(candidate.episodeCount, 10);
  assert.equal(service.getStats().totalEpisodes, 10);
  assert.equal(candidate.id, baseline.id);
  console.log(JSON.stringify({
    state: 'PASS', metric: 'unchanged_evidence_success_fraction_error',
    oracle, observedOutcomeCount: outcomes.length, replays: 9,
    baselineReportedRate: baseline.successRate, candidateReportedRate: candidate.successRate,
    currentAbsoluteError: Math.abs(candidate.successRate - oracle), currentPhantomReplications: candidate.episodeCount - outcomes.length,
    actualOutcomeImprovement: 0, providerExecuted: false, strategyApplied: false, causalImprovementClaimed: false,
    scope: 'Correction of measurement fidelity on fixed synthetic outcomes; not improved task success or autonomous learning',
  }, null, 2));
} finally { db.close(); }
