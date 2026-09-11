import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CognitiveLoopClosureService } from '../services/cognitive-loop-closure-service';
import { swarmEventBus } from '../services/swarm-event-bus';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let db: Database.Database;
let service: CognitiveLoopClosureService;
const services: CognitiveLoopClosureService[] = [];
beforeEach(() => { db = new Database(':memory:'); service = new CognitiveLoopClosureService(db); services.push(service); });
afterEach(() => { services.splice(0).forEach(item => item.stop()); db.close(); });
const metrics = { totalLeases: 1, completedLeases: 1, failedLeases: 0, totalTokens: 0, totalCostDollars: 0, diffLinesChanged: 0, filesModified: 0, gatesPassed: 1, gatesFailed: 0 };
function record(id: string, outcome: 'success' | 'failure', strategy = 'candidate', goalType = 'fixture') {
  return service.recordEpisode({ loopRunId: id, goalId: 'fixture', goalType, mode: 'closed', startedAt: '2026-09-09T00:00:00Z', completedAt: '2026-09-09T00:00:01Z', durationMs: 1000, outcome, strategy, actions: [], metrics, metadata: { synthetic: true } });
}

it('keeps strategy and meta projections current across mixed global cohorts without explicit evolution', () => {
  for (let i = 0; i < 7; i++) record(`other-${i}`, 'success', 'other-strategy', 'other-goal');
  for (let i = 0; i < 10; i++) record(`current-${i}`, i < 5 ? 'failure' : 'success');
  // Goal-level advice can tie the explicit strategy; both must use all outcomes.
  expect(service.getBestStrategy('fixture')).toMatchObject({ successRate: 0.5, episodeCount: 10 });
  expect(service.getMetaLearningStatus().find(item => item.goalType === 'fixture')).toMatchObject({ totalEpisodes: 10, bestSuccessRate: 0.5 });
  record('current-final-failure', 'failure');
  expect(service.getBestStrategy('fixture')).toMatchObject({ successRate: 5 / 11, episodeCount: 11 });
  expect(service.getMetaLearningStatus().find(item => item.goalType === 'fixture')).toMatchObject({ totalEpisodes: 11, bestSuccessRate: 5 / 11 });
});

it('repairs historical stale projections on service start without adding observations', () => {
  for (let i = 0; i < 10; i++) record(`restart-${i}`, i < 5 ? 'failure' : 'success');
  db.prepare("UPDATE cognitive_strategies SET success_rate=0.375,episode_count=8 WHERE goal_type='fixture'").run();
  db.prepare("UPDATE cognitive_meta_learning SET best_success_rate=0.375,total_episodes=8 WHERE goal_type='fixture'").run();
  const recreated = new CognitiveLoopClosureService(db); services.push(recreated);
  expect(recreated.getBestStrategy('fixture')).toMatchObject({ successRate: 0.375, episodeCount: 8 });
  recreated.start();
  expect(recreated.getBestStrategy('fixture')).toMatchObject({ successRate: 0.5, episodeCount: 10 });
  expect(recreated.getMetaLearningStatus().find(item => item.goalType === 'fixture')).toMatchObject({ bestSuccessRate: 0.5, totalEpisodes: 10 });
  recreated.start();
  expect(recreated.getStats().totalEpisodes).toBe(10);
  expect(db.prepare('SELECT COUNT(*) AS count FROM cognitive_episodes').get()).toEqual({ count: 10 });
});

it('cannot manufacture improvement by repeatedly evolving unchanged evidence', () => {
  for (let i = 0; i < 10; i++) record(`fixed-${i}`, i < 5 ? 'failure' : 'success');
  const baseline = service.getBestStrategy('fixture');
  expect(baseline).toMatchObject({ successRate: 0.5, episodeCount: 10 });
  for (let i = 0; i < 9; i++) service.evolveStrategies();
  const candidate = service.getBestStrategy('fixture');
  expect(candidate).toMatchObject({ id: baseline!.id, successRate: 0.5, episodeCount: 10 });
  expect(service.getStats()).toMatchObject({ totalEpisodes: 10, overallSuccessRate: 0.5 });
});

it('does not double-count a strategy whose name collides with derived goal advice', () => {
  for (let i = 0; i < 10; i++) record(`overlap-${i}`, i < 5 ? 'failure' : 'success', 'learned_from_fixture_outcome_correlation');
  for (let i = 0; i < 3; i++) service.evolveStrategies();
  expect(service.getStats()).toMatchObject({ totalEpisodes: 10, overallSuccessRate: 0.5 });
  expect(service.getBestStrategy('fixture')).toMatchObject({ name: 'learned_from_fixture_outcome_correlation', successRate: 0.5, episodeCount: 10, avgDurationMs: 1000 });
  const recreated = new CognitiveLoopClosureService(db); services.push(recreated);
  recreated.evolveStrategies();
  expect(recreated.getBestStrategy('fixture')).toMatchObject({ successRate: 0.5, episodeCount: 10, avgDurationMs: 1000 });
});

it.each([
  ['failure', 'success', 'failure', 'success', 'success'],
  ['success', 'failure', 'failure', 'failure', 'success'],
] as const)('matches the immutable outcome oracle across calls and recreation: %j', (...outcomes) => {
  const expected = outcomes.filter(outcome => outcome === 'success').length / outcomes.length;
  outcomes.forEach((outcome, i) => record(`heldout-${i}`, outcome));
  for (let i = 0; i < 3; i++) { service.extractPatterns(); service.evolveStrategies(); }
  const recreated = new CognitiveLoopClosureService(db); services.push(recreated);
  recreated.extractPatterns(); recreated.evolveStrategies();
  expect(recreated.getBestStrategy('fixture')).toMatchObject({ successRate: expected, episodeCount: outcomes.length });
});

it('recovers fewer-than-buffer-size durable episodes after service recreation', () => {
  for (let i = 0; i < 4; i++) record(`recreate-${i}`, 'success');
  service.stop();
  const recreated = new CognitiveLoopClosureService(db); services.push(recreated);
  expect(recreated.extractPatterns().length).toBeGreaterThan(0);
  recreated.evolveStrategies();
  expect(recreated.getBestStrategy('fixture')).toMatchObject({ successRate: 1, episodeCount: 4 });
});

it('recovers an actual file-backed database after closing and reopening it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'djimitflo-cognitive-evidence-'));
  let fileDb = new Database(join(directory, 'fixture.sqlite'));
  try {
    const initial = new CognitiveLoopClosureService(fileDb);
    for (let i = 0; i < 4; i++) initial.recordEpisode({ ...record(`file-source-${i}`, i === 0 ? 'failure' : 'success'), loopRunId: `file-${i}` });
    fileDb.close(); fileDb = new Database(join(directory, 'fixture.sqlite'));
    const reopened = new CognitiveLoopClosureService(fileDb);
    reopened.evolveStrategies();
    expect(reopened.getBestStrategy('fixture')).toMatchObject({ successRate: 0.75, episodeCount: 4 });
    reopened.evolveStrategies();
    expect(reopened.getMetaLearningStatus()).toMatchObject([{ totalEpisodes: 4 }]);
  } finally { fileDb.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('counts one loop completion once across duplicate listeners and replay', () => {
  const sibling = new CognitiveLoopClosureService(db); services.push(sibling);
  service.start(); sibling.start();
  const event = { loopRunId: 'one-loop', goalId: 'fixture', goalType: 'fixture', strategy: 'candidate', status: 'completed', durationMs: 1000 };
  swarmEventBus.emit('loop_completed', event); swarmEventBus.emit('loop_completed', event);
  expect(service.getStats().totalEpisodes).toBe(1);
  expect(db.prepare('SELECT count(*) AS count FROM cognitive_episodes').get()).toEqual({ count: 1 });
});

it('updates an existing advisory lesson without inflating its reported application count or retaining old actions', () => {
  const input = { id: 'lesson', category: 'workflow', lesson: 'Original synthetic advice', effectiveness: 80, timesApplied: 3, goalType: 'fixture', strategy: 'advice' };
  service.ingestLearning(input);
  const original = service.getBestStrategy('fixture');
  service.ingestLearning({ ...input, lesson: 'Corrected synthetic advice' });
  expect(service.getBestStrategy('fixture')).toMatchObject({ id: original!.id, episodeCount: 3, actions: ['Corrected synthetic advice'], conditions: { evidence_basis: 'self_reported' } });
  expect(service.getStats().totalEpisodes).toBe(0);
});

it('uses new durable outcomes even before the next automatic batch boundary', () => {
  for (let i = 0; i < 5; i++) record(`latest-${i}`, 'success');
  record('latest-failure', 'failure');
  service.evolveStrategies();
  expect(service.getBestStrategy('fixture')).toMatchObject({ successRate: 5 / 6, episodeCount: 6 });
});

it('does not retain an eligible high-effectiveness strategy after its sole advisory evidence is downgraded', () => {
  const input = { id: 'downgraded', category: 'workflow', lesson: 'Synthetic advice', effectiveness: 90, timesApplied: 3, goalType: 'fixture' };
  service.ingestLearning(input);
  expect(service.getBestStrategy('fixture')).not.toBeNull();
  service.ingestLearning({ ...input, effectiveness: 10 });
  expect(service.getBestStrategy('fixture')).toBeNull();
});
